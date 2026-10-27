# INDEXER.md

The state of this indexer, for whoever extends it next. The Ponder project (Ponder
0.18.2, pinned) is at the **repository root**: this is a standalone indexer repository,
not a contract project.

## Chains

| Chain | Id | RPC variable | Websocket (optional) |
| --- | --- | --- | --- |
| Ethereum mainnet (`mainnet`) | 1 | `PONDER_RPC_URL_1` (comma-separated list allowed) | `PONDER_WS_URL_1` |

## Contracts

Every address and start block is read from the environment (`src/settings.ts`), with
the mainnet deployment as the default.

| Ponder name | Address (default) | Start block (default) | End block | ABI source | Proxy / factory | Env overrides |
| --- | --- | --- | --- | --- | --- | --- |
| `SwornRegistry` | `0x0da2679000ea5380d1361cc3cca7d4e8c881f766` | 26242885 (deployment) | – | `abis/SwornRegistryAbi.ts`, the verified ABI served at https://sworn.sites.imd.fun/abi/Registry.json (source: github.com/identity-md-launches/launch-2404-renderer-composer-registry) | neither | `SWORN_REGISTRY_ADDRESS`, `SWORN_REGISTRY_START_BLOCK` |
| `ImdToken` | `0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7` | 26038414 | – | `abis/Erc20TransferAbi.ts`, the standard ERC-20 `Transfer` event (the request's signature) | neither; logs filtered by `to = IMD_PAYEE_ADDRESS` (`0x4e0fa57bde726079356537e2f34d671e9f41adbc`) in eth_getLogs | `IMD_TOKEN_ADDRESS`, `IMD_PAYEE_ADDRESS`, `IMD_TOKEN_START_BLOCK` |
| `WhitelistCurator` | `0xcb0b0531e86a9ac36fa865ca8e3dbccf047fda91` | 25769870 (deployment) | 25789721 (Settled) | `abis/WhitelistCuratorAbi.ts`, the verified ABI served at https://sworn.sites.imd.fun/abi/WhitelistCurator.json | neither | `CURATOR_ADDRESS`, `CURATOR_START_BLOCK`, `CURATOR_END_BLOCK` |
| `IdmdSeat` | `0x0000eC93127BAA929E58E97dd0095A2BFb38ec1D` | 25090085 (Swarmed window start; also the deployment block) | – | `abis/Erc721SeatAbi.ts`, standard ERC-721 `Transfer` plus `totalSupply`/`ownerOf` views | neither | `IDMD_SEAT_ADDRESS`, `IDMD_SEAT_START_BLOCK` |

Reads: `SwornRegistry.specOf(uint16)` once per `SpecRegistered`, at the event's block.
`IdmdSeat` has a setup handler that, only when the start block is set after the
collection's deployment, reads `totalSupply` and `ownerOf` (Multicall3,
`MULTICALL3_ADDRESS`) at `startBlock - 1` to seed the holders at the window start. With
the default start block there is no code before it and nothing is read.

## Tables

| Table | Primary key | Written by |
| --- | --- | --- |
| `card` | `token_id` | `SwornRegistry:CardMinted` (claimant, mint block/tx), `SwornRegistry:Transfer` (holder) |
| `card_transfer` | `id` (event id) | `SwornRegistry:Transfer` |
| `trait_request` | `request_id` | `SwornRegistry:TraitRequested` (state `pending`), `Verified` (`verified`, oracle request id), `Missed` (`missed`, reason), `NoVerdict` (`noverdict`, status, reason, agreed, answered), `Abandoned` (`abandoned`) |
| `rule` | `trait_id` | `SwornRegistry:SpecRegistered` + `specOf` read (kind, target, item, arg, fixedArg, fixedVal, sumArg, op, threshold, fromBlock, toBlock, name), registrant, block, tx |
| `shared_fact` | `id` (event id) | `SwornRegistry:SharedFactStored` |
| `metadata_update` | `id` (event id) | `SwornRegistry:MetadataUpdate`, `SwornRegistry:BatchMetadataUpdate` |
| `imd_payment` | `id` (event id) | `ImdToken:Transfer` (to the payee only): from, to, value, block, log index, tx, timestamp. Window counts are queries over these rows; no totals are stored. |
| `curator_deposit` | `id` (event id) | `WhitelistCurator:Deposited` (every field of the event) |
| `curator_contributor` | `address` | `WhitelistCurator:FirstDeposit` (index, timestamp, block), `WhitelistCurator:Deposited` (first hour, count, summed amount and weightAdded, last weight) |
| `curator_hour_saved` | `id` (event id) | `WhitelistCurator:HourSaved` |
| `curator_lifecycle` | `id` (event id) | `WhitelistCurator:Launched`, `Settled`, `Rescued` (args as JSON) |
| `seat` | `token_id` | `IdmdSeat:Transfer` (current holder, open holding) |
| `seat_holding` | `id` (`<tokenId>-<block>-<logIndex>`, or `<tokenId>-seed`) | `IdmdSeat:Transfer` closes the open holding (to block/timestamp/tx) and opens one for the recipient; `IdmdSeat:setup` seeds holdings when the start block is after deployment |
| `seat_transfer` | `id` (event id) | `IdmdSeat:Transfer` |

Enum: `request_state` = `pending | verified | missed | noverdict | abandoned`.

## Events deliberately not indexed

| Contract | Event | Reason |
| --- | --- | --- |
| `SwornRegistry` | `Approval`, `ApprovalForAll` | ERC-721 approvals change no state the Sworn site, a dashboard or a report reads; ownership comes from `Transfer`. |
| `ImdToken` | `Transfer` not to the payee, `Approval` | Out of scope: only payments to the swarm's payee count for community rules, and indexing every IMD transfer would multiply RPC load for nothing the API answers. Widen `filter` in `ponder.config.ts` to add them. |
| `IdmdSeat` | `Approval`, `ApprovalForAll`, any event other than `Transfer` | Only who held which seat when is needed for the Swarmed fact; the minimal ABI carries `Transfer` only. |
| `IdmdSeat` | `Transfer` before block 25090085 | None exist: the collection was deployed in that block. |
| `WhitelistCurator` | anything after block 25789721 | The game is settled; nothing changes after the `Settled` event. |

Out of scope: accepted swarm work from the IMD control plane (offchain), which the
Swarmed fact also needs.

## Ponder patch

`patches/ponder@0.18.2.patch` (applied by pnpm from `pnpm-workspace.yaml`) removes
Ponder's built-in empty `/health` route so the app's JSON `/health` answers instead.
`/ready`, `/status` and `/metrics` are Ponder's own. Re-create the patch on a Ponder
upgrade (`pnpm patch ponder@<version>`).

## API

`src/api/index.ts`: GraphQL at `/graphql`, SQL over HTTP at `/sql/*`, and the REST
routes listed in README.md. Shared settings are in `src/settings.ts`.

## Deployment files

`Dockerfile` (one image for both targets, non-root, `scripts/start.sh`), `docker-compose.yml`
(the indexer plus the named volume `sworn-data` with PGlite; optional `postgres` profile),
`compose.caddy.yml` (joins Caddy's shared network), `railway.json` (Dockerfile builder,
`/ready` healthcheck, 3600 s), `env.example` (every variable).
