# Sworn Indexer

A [Ponder](https://ponder.sh) 0.18 indexer for Ethereum mainnet that the Sworn site reads
instead of scanning logs in the browser. It indexes:

1. the **Sworn registry** `0x0da2679000ea5380d1361cc3cca7d4e8c881f766` (cards, trait requests and
   their verdicts, community rules read with `specOf`, shared facts, metadata updates);
2. **IMD payments** to the swarm's payee `0x4e0fa57bde726079356537e2f34d671e9f41adbc`: every
   IMD (`0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7`) `Transfer` to it, one row each, so a rule's
   window count is always a query, never a stored total;
3. the settled **WhitelistCurator** game `0xcb0b0531e86a9ac36fa865ca8e3dbccf047fda91`
   (blocks 25769870 to 25789721);
4. **IDMD seats** `0x0000eC93127BAA929E58E97dd0095A2BFb38ec1D` as holding intervals per wallet
   from block 25090085.

It serves a JSON REST API for the site, plus Ponder's GraphQL (`/graphql`) and SQL over HTTP
(`/sql/*`). `INDEXER.md` records every contract, start block, table and event, and the
events deliberately left out.

One repository and one image serve both targets. Only `PONDER_RPC_URL_1`, `DATABASE_URL`,
`PORT` and `CORS_ORIGINS` differ:

| | Docker host (ours) | Railway |
| --- | --- | --- |
| Build | `docker compose up -d --build` (the `Dockerfile`) | the `Dockerfile` (`railway.json`) |
| Data | PGlite on the named volume `sworn-data` (no `DATABASE_URL`) | Railway Postgres via `DATABASE_URL` |
| Schema | the image's build id: a restart resumes, a rebuild re-indexes | `RAILWAY_DEPLOYMENT_ID` |
| Port | `PORT` (default 42069) behind Caddy | `PORT`, injected by Railway |

## Configuration

Every variable is listed with a comment in [`env.example`](env.example). Copy it to `.env`.
The file is called `env.example` rather than `.env.example` so the repository holds no
`.env*` file and no `.env*` file is ever baked into an image (`.dockerignore` excludes them).

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `PONDER_RPC_URL_1` | yes | – | Mainnet **archive** RPC. Comma-separate several to load-balance. |
| `DATABASE_URL` | no | PGlite | Postgres connection string (`DATABASE_PRIVATE_URL` wins if set). |
| `PORT` | no | 42069 | HTTP port. |
| `CORS_ORIGINS` | no | `https://sworn.vibingco.de,https://sworn.sites.imd.fun` | Allowed origins, or `*`. |
| `PGLITE_DIRECTORY` | no | `/data/pglite` in the image | PGlite data directory when there is no `DATABASE_URL`. |
| `PONDER_WS_URL_1` | no | – | Websocket for realtime tailing. |
| `DATABASE_SCHEMA` | no | `RAILWAY_DEPLOYMENT_ID`, else the image build id | Postgres schema of this deployment. |
| `PONDER_VIEWS_SCHEMA` | no | `sworn_indexer` | Stable views schema (`SELECT * FROM sworn_indexer.card`). |
| `PONDER_GETLOGS_BLOCK_RANGE` | no | 500 | Largest `eth_getLogs` span. |
| `PONDER_POLLING_INTERVAL_MS` | no | 4000 | New-block polling interval. |
| `NODE_OPTIONS`, `PONDER_CACHE_BYTES` | no | `--max-old-space-size=192 --max-semi-space-size=4`, 32 MB | Memory caps (see "Memory"). |
| `SWORN_REGISTRY_ADDRESS` / `_START_BLOCK`, `IMD_TOKEN_ADDRESS`, `IMD_PAYEE_ADDRESS`, `IMD_TOKEN_START_BLOCK`, `CURATOR_ADDRESS` / `_START_BLOCK` / `_END_BLOCK`, `IDMD_SEAT_ADDRESS` / `_START_BLOCK` | no | the mainnet deployments | Contract overrides (see `INDEXER.md`). |

**RPC.** The backfill needs an archive endpoint: `eth_getLogs` back to block 25090085 and
`eth_call` at old blocks. Public endpoints that worked on 2026-10-27:
`https://gateway.tenderly.co/public/mainnet`, `https://one.valve.city/rpc/vk_demo/evm/1`,
`https://ethereum.public.blockpi.network/v1/rpc/public`, `https://public-eth.nownodes.io`.
Ones that did not: publicnode (archive needs a token), flashbots (empty archive logs),
drpc free, 1rpc, blastapi, tatum, nodies, blockrazor (spans of 10 to 100 blocks), ankr and zan
(key required). More are listed at chainlist.org. Every URL you list must be archive for both logs and
state (see "Mainnet run"). Public endpoints rate-limit a backfill. A keyed endpoint
(Alchemy, QuickNode, your own node) is what production wants.

## Run it locally

Needs Node >= 22.12 and pnpm 10 (`npm i -g pnpm@10.34.9`).

```sh
pnpm install            # applies patches/ponder@0.18.2.patch
cp env.example .env     # set PONDER_RPC_URL_1
pnpm codegen && pnpm typecheck
pnpm dev                # hot reload, PGlite in .ponder/pglite, http://localhost:42069
# or, as the container runs it:
sh scripts/start.sh     # ponder start --schema <id> --views-schema sworn_indexer
```

`curl localhost:42069/health` answers at once. `/ready` answers 200 once the backfill
reaches the head.

## Deploy on our Docker host (Docker Compose, Caddy, PGlite on a volume)

Target: Linux x86_64, Docker Compose v2, 2 shared vCPUs, about 512 MB of RAM, Caddy on a
shared Docker network. One container plus one named volume. With no `DATABASE_URL` the data
is in PGlite at `/data/pglite` on the volume `sworn-data`. There is no database container.

1. Clone the repository on the host and create the env file:
   ```sh
   git clone <this repository> sworn-indexer && cd sworn-indexer
   cp env.example .env
   # edit .env: set PONDER_RPC_URL_1 (required). Leave DATABASE_URL empty.
   ```
2. Build and start. `compose.caddy.yml` joins the container to Caddy's shared network,
   named by `CADDY_NETWORK` (default `caddy`; create it once with `docker network create caddy`
   if Caddy has not). Without Caddy, plain `docker compose up -d --build` is enough.
   ```sh
   docker compose -f docker-compose.yml -f compose.caddy.yml up -d --build
   docker compose logs -f indexer        # backfill progress
   curl -s localhost:42069/health        # JSON within seconds of start
   curl -si localhost:42069/ready        # 503 during the backfill, 200 once at the head
   ```
3. Point Caddy at the container over the shared network (no published port needed;
   drop `ports:` from the Compose file if you do not want 42069 on the host):
   ```caddyfile
   sworn-indexer.example.org {
       reverse_proxy indexer:42069
   }
   ```
   If another stack on that network also has a service called `indexer`, use the
   container name instead (`docker compose ps` shows it, e.g. `sworn-indexer-indexer-1`).
4. **Restarts resume.** `docker compose restart indexer`, a crash or a host reboot (the
   service has `restart: unless-stopped`) starts the same image with the same schema on the
   same volume. Ponder finds its checkpoint ("Detected crash recovery") and continues from
   the stored block. It does not backfill again.
5. **Shipping a change.** Pull, then run the same `up -d --build` command. The new image gets a new
   build id, so it indexes into a fresh schema inside the same PGlite database. The RPC cache
   on the volume is reused, so the re-index is fast (minutes) and makes almost no RPC
   calls. The API is down for those minutes, because Compose stops the old container first.
   Old schemas stay on the volume. Drop them with `docker compose run --rm indexer
   ./node_modules/.bin/ponder db prune` when disk matters.
6. Optional Postgres on a host that has room for it: set `POSTGRES_PASSWORD` and
   `DATABASE_URL=postgres://postgres:<password>@postgres:5432/postgres` in `.env`, then
   `docker compose --profile postgres up -d --build`. The data then lives in the
   `sworn-pgdata` volume.

The container runs as the unprivileged `node` user (uid 1000) under `tini`. The Compose
healthcheck calls `/health` (liveness: interval 15 s, timeout 5 s, 60 s start period), so a
long backfill never marks the container unhealthy. Gate traffic or scripts on `/ready`, which
answers 200 only once the backfill reaches the head. That took about 28 minutes on public
RPCs: poll it with a timeout of at least an hour, e.g.
`timeout 3600 sh -c 'until curl -sf localhost:42069/ready; do sleep 10; done'`.
With the `postgres` profile, the indexer may start before Postgres accepts connections;
it exits and `restart: unless-stopped` retries it until Postgres is up. Limits: `mem_limit` (`MEM_LIMIT`, default 768m, see "Memory") and
`cpus: 2`.

## Deploy on Railway (the swarm's target)

1. Push this repository to GitHub. On Railway: **New Project → Deploy from GitHub repo** and
   pick it. `railway.json` selects the `Dockerfile` builder, healthcheck path `/ready` with a
   3600 s timeout, and restart always. It sets no start command, so the Dockerfile's
   `CMD ["sh", "scripts/start.sh"]` runs.
2. In the project: **Create → Database → Add PostgreSQL**. On the indexer service's
   **Variables**, add `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (the private address).
   Keep both services in one region. Ponder slows sharply above about 50 ms of round trip.
3. Add `PONDER_RPC_URL_1` (and `PONDER_WS_URL_1` if you have one). Optionally add
   `CORS_ORIGINS`, `PONDER_VIEWS_SCHEMA` and any contract override. `PORT` is injected by
   Railway. `RAILWAY_DEPLOYMENT_ID` becomes the schema, so each deploy indexes into a fresh
   schema while the previous one keeps serving. That is what makes deploys zero-downtime.
4. **Healthcheck.** `/ready` (set by `railway.json`, or Settings → Deploy → Healthcheck Path)
   answers 503 until the backfill reaches the head. Railway waits up to
   `healthcheckTimeout` = 3600 s (equivalently the variable `RAILWAY_HEALTHCHECK_TIMEOUT_SEC=3600`)
   before it moves traffic. The measured backfill below takes well under an hour on a keyed
   RPC. On a public RPC, check its duration against that timeout. If it can exceed an hour,
   switch the healthcheck to `/health` and accept partial data until it catches up.
5. **Settings → Networking → Generate Domain.** The REST routes, `/graphql`, `/sql/*`,
   `/status` and `/ready` are served on it.
6. Each deploy leaves its old schema behind. Run `pnpm exec ponder db list` and
   `pnpm exec ponder db prune` against the database (with `DATABASE_URL` set locally) from
   time to time. Prune drops only schemas no live deployment uses. Heavy query traffic is
   served by more replicas of `ponder serve` on the same schema, not by a bigger indexer.

## Mainnet run: what was run and what it showed (2026-10-27)

Run on the build machine with `ponder start` (the same path as `scripts/start.sh`) on PGlite,
Node 22.23, `NODE_OPTIONS="--max-old-space-size=192 --max-semi-space-size=4"`,
`PONDER_CACHE_BYTES=33554432`, `PONDER_GETLOGS_BLOCK_RANGE=500`.

**Backfill duration.** About **28 minutes** of wall clock from an empty database to the head
(block 26280540) for all four contracts, blocks 25090085 to 26280540 (1.19 M blocks). The
time split three ways:
- 10 min (00:19:55 to 00:29:50 UTC) on `gateway.tenderly.co/public/mainnet` +
  `one.valve.city/rpc/vk_demo/evm/1`: 57 % of the range;
- 16 min 27 s (00:29:55 to 00:46:23) to fetch the rest, after a restart that added blockpi
  and nownodes;
- 24 s to index everything from the stored RPC cache, after the fix described next.

Almost all of the time goes into the curator game: about 20,000 blocks holding 47,000
events, and Ponder fetches each of those blocks in full. The public RPCs answered with
HTTP 429 or "rate limit exceeded" thousands of times. Ponder's retry and adaptive rate
limiting absorbed every one of them with no manual help.

**What failed and was fixed.**
- Tenderly answers an `eth_getLogs` that would return more than 20,000 logs with
  `-32602 invalid params`. Ponder does not recognize that as "range too large" and
  retries the same range forever. The curator game holds about 12,600 logs per 2,000
  blocks, so the span is now 500 by default.
- blockpi and nownodes serve archive logs but not archive state: `eth_call` at an old
  block answers "historical state … is not available". The run stopped at rule 10001's
  `specOf` read. The read now retries, and **every URL in `PONDER_RPC_URL_1` must be
  archive for both logs and state**. That held for Tenderly and valve.city.
- The final index was built into a fresh schema from the stored RPC cache in 24 s.

**Restart resumes.** Every restart of `ponder start` with the same schema logged
`Detected crash recovery … schema=b-final3` and continued from the stored checkpoint:
`Started backfill indexing block_range=[26280540,26280549]`, then
`Completed backfill indexing (532ms)`, then live indexing. The earlier runs resumed at
blocks 25564937 and 25771595 the same way. Nothing was backfilled again.

**Tailing.** After the backfill the process indexes each new block within a second of
polling (`Indexed block … event_count=0 (15ms)`) and keeps `/health`'s `chainHead` current.

**Acceptance numbers, all from the run:** `/rules` lists rule 10001 "Early Flock", kind 1,
target the IMD token, window 26038414 to 26279931, threshold 5, registrant
`0x84f4…8ada`. Eligibility returns count 5 / met true for `0x887b…a88c`, 47 / true for
`0xe5b1…4f2a`, and 0 / false for `0x84f4…8ada`. Wallet `0x887b…a88c` has card 2 and verified
traits 601, 701, 1301 and 1105. There are 15 cards. Seat 420 has belonged to `0xe5b1…4f2a`
since block 26013599 (2026-09-19). The curator game has 19,522 contributors, 28,353
deposits, 41 HourSaved by 33 saviors, and 5,958 deposits by 3,936 contributors in hours 24
to 65. `0x887b…a88c` has first-deposit index 95, first hour 0, 7 deposits, 5 of them in
hours 24 to 65. `/curator/top?n=32` returns 32 wallets in descending order. Every
response carries `access-control-allow-origin`.

**Commands run:** `pnpm install`, `pnpm codegen` and `pnpm typecheck` all pass. `ponder start`
was run against mainnet as above, and every endpoint and GraphQL query in this README was
called against it. **Not run here:** `docker build` and `docker compose up`, because this
machine has no Docker. The Dockerfile, Compose file and Railway steps follow the run
above but are untested as containers. The first `docker compose up` is the check.

**getLogs span and RPC limits tolerated.** Span 500 blocks (`PONDER_GETLOGS_BLOCK_RANGE`).
Ponder halves it further on "range too large" style errors. That covers endpoints capped at
500 blocks or more, and Tenderly's 20,000-result cap. Endpoints capped at 10 to 100 blocks
(blastapi, tatum, nodies, blockrazor) would need a smaller span and would be very slow.
The run tolerated per-second rate limits (HTTP 429, `-32005`) and timeouts. Ponder retries
with backoff and spreads load over every URL in the list.

## Memory

Measured RSS of the `ponder start` process on PGlite:

| Phase | RSS |
| --- | --- |
| Tailing after the backfill (restart, live indexing) | **424 to 440 MB** |
| Backfill, steady | 540 to 550 MB |
| Backfill, peak (curator blocks; indexing from cache) | **657 MB** |

PGlite alone takes about 300 MB: its WASM Postgres reserves around 270 MB at start. The
V8 heap is capped at 192 MB and its young generation at 4 MB, and Ponder's indexing
cache at 32 MB. **So tailing fits the host's 512 MB, but a backfill on PGlite does not.**
`docker-compose.yml` therefore sets `mem_limit: ${MEM_LIMIT:-768m}`. If the host cannot
give 768 MB for the backfill, two things help. First, backfill once elsewhere, or with a
temporary higher limit, and then lower `MEM_LIMIT` to `512m`: a restart only resumes, which
stays in the tailing range. Second, if an OOM kill happens mid-backfill, the container
restarts and resumes from the last checkpoint. With Postgres (`DATABASE_URL`) the PGlite
300 MB is not in the process.

## Querying

### SQL

Over HTTP at `/sql/*` (what `@ponder/client` uses; read-only, `SELECT` only):

```sh
curl -s -G localhost:42069/sql/db --data-urlencode \
  'sql={"json":{"sql":"SELECT hour, count(*) AS deposits FROM curator_deposit WHERE hour BETWEEN 24 AND 26 GROUP BY hour ORDER BY hour","params":[],"typings":[]}}'
# {"rows":[{"hour":24,"deposits":131},{"hour":25,"deposits":56},{"hour":26,"deposits":37}],...}
```

On Postgres, query the views schema directly, e.g. `SELECT * FROM sworn_indexer.card;`, or
count a rule window yourself:

```sql
SELECT count(*) FROM sworn_indexer.imd_payment
WHERE "from" = '0xe5b1275fb926613d983da33fbfe1f331b7f64f2a' AND block_number BETWEEN 26038414 AND 26279931;  -- 47
```

### GraphQL, one query per table

POST `{"query": "..."}` to `/graphql` (GraphiQL opens at the same URL in a browser). Every
answer below is from the mainnet run, with long lists trimmed. `shared_fact` is empty
because no `SharedFactStored` has been emitted yet.

**`card`**: Which cards exist, who claimed them and who holds them now?

```graphql
{ cards(orderBy: "tokenId", orderDirection: "asc", limit: 3) { items { tokenId claimant holder mintBlock } totalCount } }
```

```json
{"data":{"cards":{"items":[{"tokenId":"1","claimant":"0xe5b1275fb926613d983da33fbfe1f331b7f64f2a","holder":"0xe5b1275fb926613d983da33fbfe1f331b7f64f2a","mintBlock":"26243234"},{"tokenId":"2","claimant":"0x887b86b6b6957f7bbea88b8cefd392f39236a88c","holder":"0x887b86b6b6957f7bbea88b8cefd392f39236a88c","mintBlock":"26243580"},{"tokenId":"3","claimant":"0x84f4b7424e1b0464f9c749725c1f34bed9aa8ada","holder":"0x84f4b7424e1b0464f9c749725c1f34bed9aa8ada","mintBlock":"26244254"}],"totalCount":15}}}
```

**`cardTransfer`**: How has card 2 moved?

```graphql
{ cardTransfers(where: { tokenId: "2" }) { items { from to blockNumber transactionHash } } }
```

```json
{"data":{"cardTransfers":{"items":[{"from":"0x0000000000000000000000000000000000000000","to":"0x887b86b6b6957f7bbea88b8cefd392f39236a88c","blockNumber":"26243580","transactionHash":"0x1b1b2531941a4375ca7a2465f9c86288c21b1d8ba08d4a7eeb751c80d5a8c2e3"}]}}}
```

**`traitRequest`**: Which traits has this wallet had verified?

```graphql
{ traitRequests(where: { claimant: "0x887b86b6b6957f7bbea88b8cefd392f39236a88c", state: verified }) { items { traitId requestId state resolvedBlock } } }
```

```json
{"data":{"traitRequests":{"items":[{"traitId":1301,"requestId":"0x102e8123b90c6a809fd9e86e84b3e1f39978c06ccb281572c5fad3fbfc080480","state":"verified","resolvedBlock":"26265787"},{"traitId":1105,"requestId":"0x2c984058a5d3cbf73ff3e0b05903bab274684d8c28937c88a740f63b02a06ce0","state":"verified","resolvedBlock":"26267139"},{"traitId":601,"requestId":"0x3a83e6ecfc4499f1a0c87687796839a4012e874c5c3ee3377e36783266d37566","state":"verified","resolvedBlock":"26247803"},"… 1 more"]}}}
```

**`rule`**: What does community rule 10001 require?

```graphql
{ rule(traitId: 10001) { name kind target fixedArg fixedVal threshold fromBlock toBlock registrant } }
```

```json
{"data":{"rule":{"name":"Early Flock","kind":1,"target":"0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7","fixedArg":"to","fixedVal":"445650206979829807574014937046434898673003507132","threshold":"5","fromBlock":"26038414","toBlock":"26279931","registrant":"0x84f4b7424e1b0464f9c749725c1f34bed9aa8ada"}}}
```

**`sharedFact`**: Which shared facts were stored most recently?

```graphql
{ sharedFacts(limit: 3, orderBy: "blockNumber", orderDirection: "desc") { items { factId requestId length blockNumber } totalCount } }
```

```json
{"data":{"sharedFacts":{"items":[],"totalCount":0}}}
```

**`metadataUpdate`**: Which card metadata changed last?

```graphql
{ metadataUpdates(limit: 3, orderBy: "blockNumber", orderDirection: "desc") { items { fromTokenId toTokenId batch blockNumber } totalCount } }
```

```json
{"data":{"metadataUpdates":{"items":[{"fromTokenId":"13","toTokenId":"13","batch":false,"blockNumber":"26276054"},{"fromTokenId":"12","toTokenId":"12","batch":false,"blockNumber":"26274443"},{"fromTokenId":"6","toTokenId":"6","batch":false,"blockNumber":"26271741"}],"totalCount":13}}}
```

**`imdPayment`**: How many payee transfers did this wallet send inside rule 10001's window?

```graphql
{ imdPayments(where: { from: "0x887b86b6b6957f7bbea88b8cefd392f39236a88c", blockNumber_gte: "26038414", blockNumber_lte: "26279931" }) { totalCount items { blockNumber transactionHash value } } }
```

```json
{"data":{"imdPayments":{"totalCount":5,"items":[{"blockNumber":"26257855","transactionHash":"0x73e8886833c29bec0760f6c3f2e89497ed24b5cd8591579e55a01c0f08fb967a","value":"500000000000000000"},{"blockNumber":"26258164","transactionHash":"0x1dc2618fffd1e7c88c06e9a6bff8881d9df7ea31cea27dd6cd2280988c8ad2e9","value":"500000000000000000"},{"blockNumber":"26258774","transactionHash":"0xa4832deeaea0637d842513864f00cee3f5f72622f4e5924efda3de0d9bfda6d7","value":"500000000000000000"},"… 2 more"]}}}
```

**`curatorDeposit`**: How many deposits were made in hours 24 to 65?

```graphql
{ curatorDeposits(where: { hour_gte: 24, hour_lte: 65 }, limit: 1) { totalCount items { contributor hour amount weightAdded } } }
```

```json
{"data":{"curatorDeposits":{"totalCount":5958,"items":[{"contributor":"0x887b86b6b6957f7bbea88b8cefd392f39236a88c","hour":24,"amount":"269000000000000000","weightAdded":"100000000000000000"}]}}}
```

**`curatorContributor`**: Who has the highest summed weight in the curator game?

```graphql
{ curatorContributors(orderBy: "totalWeightAdded", orderDirection: "desc", limit: 3) { items { address totalWeightAdded depositCount firstDepositIndex } } }
```

```json
{"data":{"curatorContributors":{"items":[{"address":"0x2fe4093c894749e596f458764c377bf4f1337b58","totalWeightAdded":"1363396200000000000000","depositCount":2,"firstDepositIndex":"5665"},{"address":"0xe781b28e02ed5fc4b989905cb6848d318f4735fd","totalWeightAdded":"1139900000000000000000","depositCount":1,"firstDepositIndex":"14344"},{"address":"0x383f42b5de515c564641f65f5da3bd8b4a35b4b4","totalWeightAdded":"1125424000000000000000","depositCount":1,"firstDepositIndex":"3174"}]}}}
```

**`curatorHourSaved`**: Who saved the first hours?

```graphql
{ curatorHourSaveds(orderBy: "hour", orderDirection: "asc", limit: 3) { totalCount items { savior hour hourTotal } } }
```

```json
{"data":{"curatorHourSaveds":{"totalCount":41,"items":[{"savior":"0x771debfa5b6b855f2b0ef1d480219397cc32e190","hour":24,"hourTotal":"5094000000000000000"},{"savior":"0xcefdb5f635bfc913d12e6eac3738e92b1681bd65","hour":25,"hourTotal":"7299976661200000000"},{"savior":"0xcefdb5f635bfc913d12e6eac3738e92b1681bd65","hour":26,"hourTotal":"5000000000000000000"}]}}}
```

**`curatorLifecycle`**: When was the game launched and settled, with which parameters?

```graphql
{ curatorLifecycles { items { event args blockNumber } } }
```

```json
{"data":{"curatorLifecycles":{"items":[{"event":"Launched","args":{"launchTime":"1786910327","hourlyThreshold":"5000000000000000000","gracePeriod":"86400","hourDuration":"3600","minDeposit":"50000000000000000","minEscalation":"100000000000000000","creditCap":"1000000000000000000000"},"blockNumber":"25769870"},{"event":"Settled","args":{"hour":"66","timestamp":"1787149319","totalContributors":"19522","totalVolume":"128130757405814931142528"},"blockNumber":"25789721"}]}}}
```

**`seat`**: Who holds IDMD seat 420 now?

```graphql
{ seat(tokenId: "420") { holder openHoldingId } }
```

```json
{"data":{"seat":{"holder":"0xe5b1275fb926613d983da33fbfe1f331b7f64f2a","openHoldingId":"420-26013599-163"}}}
```

**`seatHolding`**: Who held seat 420, and when?

```graphql
{ seatHoldings(where: { tokenId: "420" }, orderBy: "fromBlock", orderDirection: "asc") { items { holder fromBlock toBlock fromTimestamp } } }
```

```json
{"data":{"seatHoldings":{"items":[{"holder":"0xd2880248a441157e1df2b77da073b33a45e6121f","fromBlock":"25090166","toBlock":"26013599","fromTimestamp":"1778723075"},{"holder":"0xe5b1275fb926613d983da33fbfe1f331b7f64f2a","fromBlock":"26013599","toBlock":null,"fromTimestamp":"1789845503"}]}}}
```

**`seatTransfer`**: Which IDMD seats were sent to this wallet?

```graphql
{ seatTransfers(where: { to: "0xe5b1275fb926613d983da33fbfe1f331b7f64f2a" }) { items { tokenId from blockNumber transactionHash } } }
```

```json
{"data":{"seatTransfers":{"items":[{"tokenId":"420","from":"0xd2880248a441157e1df2b77da073b33a45e6121f","blockNumber":"26013599","transactionHash":"0x45b14e7fb708357c003a60f31d4d15237fd5540c08a6cbe105e57df2e14961d6"}]}}}
```


## REST endpoints

All answer JSON (bigints as decimal strings; blocks, timestamps and ids as numbers) with
`access-control-allow-origin` set to the request's origin when it is in `CORS_ORIGINS`, else
the first configured origin (or `*` when `CORS_ORIGINS=*`). Every example below is a real
response from the mainnet run on 2026-10-27; long lists are trimmed.

### `GET /health`

Chain head seen, last indexed block per contract (null before its start block; the curator stops at its end block), and whether the backfill is complete. Answers as soon as the process is up. `/ready` (Ponder's own) answers 503 until the backfill reaches the head, then 200.

```json
{
  "status": "ok",
  "chainId": 1,
  "chainHead": 26280567,
  "chainHeadSeenAt": "2026-10-27T00:51:08.903Z",
  "lastIndexedBlock": 26280569,
  "backfillComplete": true,
  "contracts": {
    "SwornRegistry": {
      "address": "0x0da2679000ea5380d1361cc3cca7d4e8c881f766",
      "startBlock": 26242885,
      "endBlock": null,
      "lastIndexedBlock": 26280569
    },
    "ImdToken": {
      "address": "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7",
      "payee": "0x4e0fa57bde726079356537e2f34d671e9f41adbc",
      "startBlock": 26038414,
      "endBlock": null,
      "lastIndexedBlock": 26280569
    },
    "WhitelistCurator": {
      "address": "0xcb0b0531e86a9ac36fa865ca8e3dbccf047fda91",
      "startBlock": 25769870,
      "endBlock": 25789721,
      "lastIndexedBlock": 25789721
    },
    "IdmdSeat": {
      "address": "0x0000ec93127baa929e58e97dd0095a2bfb38ec1d",
      "startBlock": 25090085,
      "endBlock": null,
      "lastIndexedBlock": 26280569
    }
  }
}
```

### `GET /rules`

Every registered community rule, as `specOf` returned it at the registration block, with registrant, block and transaction. `fixedValAsAddress` decodes `fixedVal` when it fits an address.

```json
{
  "rules": [
    {
      "id": 10001,
      "name": "Early Flock",
      "kind": 1,
      "target": "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7",
      "item": "event Transfer(address indexed from, address indexed to, uint256 value)",
      "arg": "from",
      "fixedArg": "to",
      "fixedVal": "445650206979829807574014937046434898673003507132",
      "fixedValAsAddress": "0x4e0fa57bde726079356537e2f34d671e9f41adbc",
      "sumArg": "",
      "op": 0,
      "threshold": "5",
      "fromBlock": 26038414,
      "toBlock": 26279931,
      "registrant": "0x84f4b7424e1b0464f9c749725c1f34bed9aa8ada",
      "blockNumber": 26280083,
      "timestamp": 1793056439,
      "transactionHash": "0xa2a5b65af2893889dd50f470022535b0ccdb08af5c83d48820af98523a320218"
    }
  ]
}
```

### `GET /rules/10001/eligibility?wallet=0x887b86b6b6957f7bbea88b8cefd392f39236a88c`

Supported shape: kind 1, target the IMD token, item `event Transfer(address indexed from, address indexed to, uint256 value)`, `fixedArg` `to` = the payee, counted per `from`. Counts the stored payee transfers from the wallet inside the rule's window (a query, nothing stored), compares with `op` (0 is `>=`) and lists every block and transaction counted. Any other shape answers `{"supported": false, "rule": {…}}`.

```json
{
  "supported": true,
  "ruleId": 10001,
  "name": "Early Flock",
  "wallet": "0x887b86b6b6957f7bbea88b8cefd392f39236a88c",
  "count": 5,
  "threshold": "5",
  "op": 0,
  "met": true,
  "window": {
    "fromBlock": 26038414,
    "toBlock": 26279931
  },
  "windowFullyIndexed": true,
  "lastIndexedBlock": 26280566,
  "transfers": [
    {
      "blockNumber": 26257855,
      "logIndex": 355,
      "transactionHash": "0x73e8886833c29bec0760f6c3f2e89497ed24b5cd8591579e55a01c0f08fb967a",
      "value": "500000000000000000",
      "timestamp": 1792788935
    },
    {
      "blockNumber": 26258164,
      "logIndex": 203,
      "transactionHash": "0x1dc2618fffd1e7c88c06e9a6bff8881d9df7ea31cea27dd6cd2280988c8ad2e9",
      "value": "500000000000000000",
      "timestamp": 1792792655
    },
    {
      "blockNumber": 26258774,
      "logIndex": 856,
      "transactionHash": "0xa4832deeaea0637d842513864f00cee3f5f72622f4e5924efda3de0d9bfda6d7",
      "value": "500000000000000000",
      "timestamp": 1792800011
    },
    {
      "blockNumber": 26263709,
      "logIndex": 369,
      "transactionHash": "0x9baa838e06ca0fc03d94787c0789747d612de7788bae5ef4f357d2f3a9aa3038",
      "value": "500000000000000000",
      "timestamp": 1792859363
    },
    {
      "blockNumber": 26267204,
      "logIndex": 380,
      "transactionHash": "0xbf6f1c555ceb1512f3b143b917e725123604cf0c632edb48fd60068ed28d132d",
      "value": "500000000000000000",
      "timestamp": 1792901387
    }
  ]
}
```

### `GET /rules/10001/eligibility?wallet=0xe5b1275fb926613d983da33fbfe1f331b7f64f2a`



```json
{
  "supported": true,
  "ruleId": 10001,
  "name": "Early Flock",
  "wallet": "0xe5b1275fb926613d983da33fbfe1f331b7f64f2a",
  "count": 47,
  "threshold": "5",
  "op": 0,
  "met": true,
  "window": {
    "fromBlock": 26038414,
    "toBlock": 26279931
  },
  "windowFullyIndexed": true,
  "lastIndexedBlock": 26280566,
  "transfers": [
    {
      "blockNumber": 26163827,
      "logIndex": 187,
      "transactionHash": "0x9c9b61d90d202084cf4cda99ed0ab3ba90061d70e8e530c054f5404911da51a9",
      "value": "500000000000000000",
      "timestamp": 1791656903
    },
    {
      "blockNumber": 26165695,
      "logIndex": 200,
      "transactionHash": "0x2f442dc92de40d45b037bf1e211950bba3799e55fcf9370013d10d5aa30bdf57",
      "value": "500000000000000000",
      "timestamp": 1791679379
    },
    "… 45 more transfers (trimmed in this README)"
  ]
}
```

### `GET /rules/10001/eligibility?wallet=0x84f4b7424e1b0464f9c749725c1f34bed9aa8ada`



```json
{
  "supported": true,
  "ruleId": 10001,
  "name": "Early Flock",
  "wallet": "0x84f4b7424e1b0464f9c749725c1f34bed9aa8ada",
  "count": 0,
  "threshold": "5",
  "op": 0,
  "met": false,
  "window": {
    "fromBlock": 26038414,
    "toBlock": 26279931
  },
  "windowFullyIndexed": true,
  "lastIndexedBlock": 26280566,
  "transfers": []
}
```

### `GET /wallets/0x887b86b6b6957f7bbea88b8cefd392f39236a88c`

Card (tokenId if minted), every trait request with its state (`pending`, `verified`, `missed`, `noverdict`, `abandoned`) and reason or status codes, the verified traits, and the wallet's IMD payments to the payee with their blocks.

```json
{
  "wallet": "0x887b86b6b6957f7bbea88b8cefd392f39236a88c",
  "card": {
    "tokenId": 2,
    "holder": "0x887b86b6b6957f7bbea88b8cefd392f39236a88c",
    "mintBlock": 26243580,
    "mintTx": "0x1b1b2531941a4375ca7a2465f9c86288c21b1d8ba08d4a7eeb751c80d5a8c2e3"
  },
  "cardsHeld": [
    "2"
  ],
  "requests": [
    {
      "traitId": 601,
      "requestId": "0x3a83e6ecfc4499f1a0c87687796839a4012e874c5c3ee3377e36783266d37566",
      "state": "verified",
      "questionHash": "0x16423e29ce4c9a036db96f97906cc091c266ab011581cffb3f3b23f2bebea46c",
      "requestedBlock": 26247674,
      "requestedTx": "0xcea5094fa07ea0807e1304347bdf1cb2086ccefda0fd27069e6886a03a9ab4d9",
      "resolvedBlock": 26247803,
      "resolvedTx": "0xbb7aab367d22b87c4349e89a3a5327faab7a89be1539dec0d87ca31938862208",
      "oracleRequestId": "0x5c2a22459d684c56bbfb2aa322ddbd0f00000000000000000000000000000000",
      "missedReason": null,
      "noVerdict": null
    },
    {
      "traitId": 701,
      "requestId": "0xe9bc7125a96e91b70d0b696665ec3eccf7ab9a363f8f462f19dafa3ac72056a1",
      "state": "verified",
      "questionHash": "0xb87977b612a902ebd4bb10e5e586a214c12743f0c14c85adb853746e6451b80c",
      "requestedBlock": 26250313,
      "requestedTx": "0x97652c02ecd1c301550c79cd312f40d94874528f2933f66e3afe70a64f8a1a1c",
      "resolvedBlock": 26250324,
      "resolvedTx": "0x2accf9f5f54d17fc7aed6f5d4b8829165cf65f8d05d5c7dace2387ad0f038e51",
      "oracleRequestId": "0x1955dd4ca8094c0d943261cce4cf7c4c00000000000000000000000000000000",
      "missedReason": null,
      "noVerdict": null
    },
    {
      "traitId": 1301,
      "requestId": "0x102e8123b90c6a809fd9e86e84b3e1f39978c06ccb281572c5fad3fbfc080480",
      "state": "verified",
      "questionHash": "0x7f30e65b4524251f4bedfb51aa2013053a3ba9e29495b016b4df846ecc706e80",
      "requestedBlock": 26265774,
      "requestedTx": "0x0288294c3aa8abe4e072e374d1bacb0e74c8657f3251fccc78233695f2fdc045",
      "resolvedBlock": 26265787,
      "resolvedTx": "0xede9a2d4a0bfd06785b09b3f8d0a205330ff59273b3f522a2a8b511fd806de0d",
      "oracleRequestId": "0x81246c6452804f83bd76134aab0efed300000000000000000000000000000000",
      "missedReason": null,
      "noVerdict": null
    },
    {
      "traitId": 1105,
      "requestId": "0x2c984058a5d3cbf73ff3e0b05903bab274684d8c28937c88a740f63b02a06ce0",
      "state": "verified",
      "questionHash": "0x79d7614945e9606735769f78bb69071364fd26ff21a6ece77b49289fe9708ff3",
      "requestedBlock": 26267128,
      "requestedTx": "0xbd8dc209c88d82826b630e8636bbf44678fba4cafa813167ae6e7624130a1734",
      "resolvedBlock": 26267139,
      "resolvedTx": "0xe4bff3dfd619739a63cc8d1ed70fc3fe153dd38b49363f2f86359abd408998eb",
      "oracleRequestId": "0x86c62739d619471f828b59ab9e81b91400000000000000000000000000000000",
      "missedReason": null,
      "noVerdict": null
    }
  ],
  "verifiedTraits": [
    {
      "traitId": 601,
      "requestId": "0x3a83e6ecfc4499f1a0c87687796839a4012e874c5c3ee3377e36783266d37566",
      "oracleRequestId": "0x5c2a22459d684c56bbfb2aa322ddbd0f00000000000000000000000000000000",
      "block": 26247803
    },
    {
      "traitId": 701,
      "requestId": "0xe9bc7125a96e91b70d0b696665ec3eccf7ab9a363f8f462f19dafa3ac72056a1",
      "oracleRequestId": "0x1955dd4ca8094c0d943261cce4cf7c4c00000000000000000000000000000000",
      "block": 26250324
    },
    {
      "traitId": 1301,
      "requestId": "0x102e8123b90c6a809fd9e86e84b3e1f39978c06ccb281572c5fad3fbfc080480",
      "oracleRequestId": "0x81246c6452804f83bd76134aab0efed300000000000000000000000000000000",
      "block": 26265787
    },
    {
      "traitId": 1105,
      "requestId": "0x2c984058a5d3cbf73ff3e0b05903bab274684d8c28937c88a740f63b02a06ce0",
      "oracleRequestId": "0x86c62739d619471f828b59ab9e81b91400000000000000000000000000000000",
      "block": 26267139
    }
  ],
  "payments": [
    {
      "blockNumber": 26257855,
      "logIndex": 355,
      "transactionHash": "0x73e8886833c29bec0760f6c3f2e89497ed24b5cd8591579e55a01c0f08fb967a",
      "value": "500000000000000000",
      "timestamp": 1792788935
    },
    {
      "blockNumber": 26258164,
      "logIndex": 203,
      "transactionHash": "0x1dc2618fffd1e7c88c06e9a6bff8881d9df7ea31cea27dd6cd2280988c8ad2e9",
      "value": "500000000000000000",
      "timestamp": 1792792655
    },
    "… 3 more payments (trimmed in this README)"
  ],
  "lastIndexedBlock": 26280566
}
```

### `GET /cards`

Every card with claimant, tokenId, current holder and mint block.

```json
{
  "count": 15,
  "cards": [
    {
      "tokenId": 1,
      "claimant": "0xe5b1275fb926613d983da33fbfe1f331b7f64f2a",
      "holder": "0xe5b1275fb926613d983da33fbfe1f331b7f64f2a",
      "mintBlock": 26243234,
      "mintTimestamp": 1792612847,
      "mintTx": "0xe58c7def518a6e8963f0069124b2ad11aef8ea1e7bc0251a22f7f1bb08dba687"
    },
    {
      "tokenId": 2,
      "claimant": "0x887b86b6b6957f7bbea88b8cefd392f39236a88c",
      "holder": "0x887b86b6b6957f7bbea88b8cefd392f39236a88c",
      "mintBlock": 26243580,
      "mintTimestamp": 1792617023,
      "mintTx": "0x1b1b2531941a4375ca7a2465f9c86288c21b1d8ba08d4a7eeb751c80d5a8c2e3"
    },
    {
      "tokenId": 3,
      "claimant": "0x84f4b7424e1b0464f9c749725c1f34bed9aa8ada",
      "holder": "0x84f4b7424e1b0464f9c749725c1f34bed9aa8ada",
      "mintBlock": 26244254,
      "mintTimestamp": 1792625147,
      "mintTx": "0x078d982c56982cfc26cf11514d650e682b65b1992ac2e7f05ae2273a829b094f"
    },
    "… 12 more cards (trimmed in this README)"
  ]
}
```

### `GET /payments?wallet=0x887b86b6b6957f7bbea88b8cefd392f39236a88c&from=26038414&to=26279931`

Raw payee transfers of a wallet in a block range (`from` and `to` optional, inclusive).

```json
{
  "wallet": "0x887b86b6b6957f7bbea88b8cefd392f39236a88c",
  "payee": "0x4e0fa57bde726079356537e2f34d671e9f41adbc",
  "fromBlock": 26038414,
  "toBlock": 26279931,
  "count": 5,
  "payments": [
    {
      "blockNumber": 26257855,
      "logIndex": 355,
      "transactionHash": "0x73e8886833c29bec0760f6c3f2e89497ed24b5cd8591579e55a01c0f08fb967a",
      "from": "0x887b86b6b6957f7bbea88b8cefd392f39236a88c",
      "value": "500000000000000000",
      "timestamp": 1792788935
    },
    {
      "blockNumber": 26258164,
      "logIndex": 203,
      "transactionHash": "0x1dc2618fffd1e7c88c06e9a6bff8881d9df7ea31cea27dd6cd2280988c8ad2e9",
      "from": "0x887b86b6b6957f7bbea88b8cefd392f39236a88c",
      "value": "500000000000000000",
      "timestamp": 1792792655
    },
    {
      "blockNumber": 26258774,
      "logIndex": 856,
      "transactionHash": "0xa4832deeaea0637d842513864f00cee3f5f72622f4e5924efda3de0d9bfda6d7",
      "from": "0x887b86b6b6957f7bbea88b8cefd392f39236a88c",
      "value": "500000000000000000",
      "timestamp": 1792800011
    },
    {
      "blockNumber": 26263709,
      "logIndex": 369,
      "transactionHash": "0x9baa838e06ca0fc03d94787c0789747d612de7788bae5ef4f357d2f3a9aa3038",
      "from": "0x887b86b6b6957f7bbea88b8cefd392f39236a88c",
      "value": "500000000000000000",
      "timestamp": 1792859363
    },
    {
      "blockNumber": 26267204,
      "logIndex": 380,
      "transactionHash": "0xbf6f1c555ceb1512f3b143b917e725123604cf0c632edb48fd60068ed28d132d",
      "from": "0x887b86b6b6957f7bbea88b8cefd392f39236a88c",
      "value": "500000000000000000",
      "timestamp": 1792901387
    }
  ],
  "lastIndexedBlock": 26280566
}
```

### `GET /curator/stats`

Contributors, deposits, HourSaved count and distinct saviors, the hours 24 to 65 totals, per-hour deposit counts, distinct contributors and amount totals for hours 0 to 65, and the Settled block.

```json
{
  "contributors": 19522,
  "deposits": 28353,
  "hourSaved": 41,
  "distinctSaviors": 33,
  "hours24to65": {
    "deposits": 5958,
    "contributors": 3936
  },
  "settled": {
    "block": 25789721,
    "timestamp": 1787149319,
    "transactionHash": "0xe2fa2addeece07f195b593b1968c152f6f45124f53e4cf3dfa045c34a10847d9",
    "args": {
      "hour": "66",
      "timestamp": "1787149319",
      "totalContributors": "19522",
      "totalVolume": "128130757405814931142528"
    }
  },
  "settledBlock": 25789721,
  "perHour": [
    {
      "hour": 0,
      "deposits": 149,
      "contributors": 96,
      "total": "851887546893889652639"
    },
    {
      "hour": 1,
      "deposits": 761,
      "contributors": 437,
      "total": "9987263970125228654763"
    },
    {
      "hour": 2,
      "deposits": 431,
      "contributors": 313,
      "total": "2263828567276737794408"
    },
    "… 63 more hours (0 to 65, one entry each) (trimmed in this README)"
  ]
}
```

### `GET /curator/wallets/0x887b86b6b6957f7bbea88b8cefd392f39236a88c`

A wallet's deposits (block, hour, amount, weightAdded, newWeight, txCount), its FirstDeposit index and the hour of its first deposit, its summed weightAdded and its rank by it (1 = highest; ties share a rank), and the hours it saved.

```json
{
  "wallet": "0x887b86b6b6957f7bbea88b8cefd392f39236a88c",
  "contributor": true,
  "firstDepositIndex": 95,
  "firstDepositHour": 0,
  "firstDepositBlock": 25770164,
  "firstDepositTimestamp": 1786913855,
  "depositCount": 7,
  "totalAmount": "2604000000000000000",
  "totalWeightAdded": "849784800000000000",
  "rank": 8085,
  "deposits": [
    {
      "blockNumber": 25770164,
      "transactionHash": "0x5f7a6d512a99966f61086575f19e0c6e0c61d69f01ddc9ffa537b8ecf6cf0a4d",
      "hour": 0,
      "amount": "69000000000000000",
      "weightAdded": "135184800000000000",
      "newWeight": "135184800000000000",
      "txCount": "1",
      "earlyBps": "19592"
    },
    {
      "blockNumber": 25770331,
      "transactionHash": "0xe9a4bd444536e5e2b301bca28f8b970e41125ee933243612fda15d2c61c09a60",
      "hour": 1,
      "amount": "169000000000000000",
      "weightAdded": "193600000000000000",
      "newWeight": "328784800000000000",
      "txCount": "2",
      "earlyBps": "19360"
    },
    {
      "blockNumber": 25777046,
      "transactionHash": "0xfb9639e212594474a235638b9a97756e2a3d58959164a76d6d1e9613b0de1267",
      "hour": 24,
      "amount": "269000000000000000",
      "weightAdded": "100000000000000000",
      "newWeight": "428784800000000000",
      "txCount": "3",
      "earlyBps": "10000"
    },
    {
      "blockNumber": 25777599,
      "transactionHash": "0x3a997b316f3d6edd7ed9469f8deba4c46ff809598c4303ff2428bdc0305dd571",
      "hour": 25,
      "amount": "369000000000000000",
      "weightAdded": "100000000000000000",
      "newWeight": "528784800000000000",
      "txCount": "4",
      "earlyBps": "10000"
    },
    {
      "blockNumber": 25777923,
      "transactionHash": "0xfc424f113086754fe0b41efd88206bbb64a471c58e4e257997d54cc0a6f68971",
      "hour": 26,
      "amount": "469000000000000000",
      "weightAdded": "100000000000000000",
      "newWeight": "628784800000000000",
      "txCount": "5",
      "earlyBps": "10000"
    },
    {
      "blockNumber": 25778212,
      "transactionHash": "0x760e12eace10340e7289754a8ff58c2273529a4008d34d4370769fc81ae96f4a",
      "hour": 27,
      "amount": "569000000000000000",
      "weightAdded": "100000000000000000",
      "newWeight": "728784800000000000",
      "txCount": "6",
      "earlyBps": "10000"
    },
    {
      "blockNumber": 25789576,
      "transactionHash": "0xda20ef0bc90926af7d4fe4704496f2601c9c3613cf03ff5da3611b50563ee0c7",
      "hour": 65,
      "amount": "690000000000000000",
      "weightAdded": "121000000000000000",
      "newWeight": "849784800000000000",
      "txCount": "7",
      "earlyBps": "10000"
    }
  ],
  "hoursSaved": []
}
```

### `GET /curator/top?n=32`

The n wallets with the highest summed weightAdded, ordered descending (ties by FirstDeposit index): the Top Weights candidates. `n` defaults to 32, at most 1000.

```json
{
  "n": 32,
  "wallets": [
    {
      "rank": 1,
      "wallet": "0x2fe4093c894749e596f458764c377bf4f1337b58",
      "totalWeightAdded": "1363396200000000000000",
      "depositCount": 2,
      "totalAmount": "787000000000000000000",
      "firstDepositIndex": 5665
    },
    {
      "rank": 2,
      "wallet": "0xe781b28e02ed5fc4b989905cb6848d318f4735fd",
      "totalWeightAdded": "1139900000000000000000",
      "depositCount": 1,
      "totalAmount": "4040000000000000000000",
      "firstDepositIndex": 14344
    },
    {
      "rank": 3,
      "wallet": "0x383f42b5de515c564641f65f5da3bd8b4a35b4b4",
      "totalWeightAdded": "1125424000000000000000",
      "depositCount": 1,
      "totalAmount": "620000000000000000000",
      "firstDepositIndex": 3174
    },
    {
      "rank": 4,
      "wallet": "0x1aa780bb10425b86bcf05ecbb7953f9a93729ed9",
      "totalWeightAdded": "1105727370000000000000",
      "depositCount": 1,
      "totalAmount": "806100000000000000000",
      "firstDepositIndex": 9463
    },
    "… 28 more wallets (trimmed in this README)"
  ]
}
```

### `GET /seats/0xe5b1275fb926613d983da33fbfe1f331b7f64f2a`

The IDMD seats a wallet holds or held, each as holding intervals with from and to block, timestamps and transactions (`toBlock: null` = still held). Token 420 came to this wallet in block 26013599, 2026-09-19 19:18:23 UTC.

```json
{
  "wallet": "0xe5b1275fb926613d983da33fbfe1f331b7f64f2a",
  "windowStartBlock": 25090085,
  "seats": [
    {
      "tokenId": 420,
      "holdsNow": true,
      "intervals": [
        {
          "fromBlock": 26013599,
          "fromTimestamp": 1789845503,
          "fromTx": "0x45b14e7fb708357c003a60f31d4d15237fd5540c08a6cbe105e57df2e14961d6",
          "heldBeforeWindowStart": false,
          "toBlock": null,
          "toTimestamp": null,
          "toTx": null,
          "open": true
        }
      ]
    }
  ],
  "lastIndexedBlock": 26280566
}
```

## Layout

```
ponder.config.ts       chain, contracts, database (PGlite or Postgres) from the environment
ponder.schema.ts       tables
src/settings.ts        addresses, start blocks, tunables (env with mainnet defaults)
src/sworn.ts           Sworn registry handlers
src/imd.ts             IMD payee transfers
src/curator.ts         WhitelistCurator handlers
src/seats.ts           IDMD seat holdings
src/api/index.ts       REST routes, /graphql, /sql/*, CORS
abis/                  ABIs (as const)
patches/               pnpm patch: lets the app serve /health
scripts/start.sh       schema selection + ponder start (Compose, Railway, by hand)
Dockerfile, docker-compose.yml, railway.json, env.example
INDEXER.md             contracts, tables, events, what is left out
```
