import { db, publicClients } from "ponder:api";
import schema from "ponder:schema";
import {
  card,
  curatorContributor,
  curatorDeposit,
  curatorHourSaved,
  curatorLifecycle,
  imdPayment,
  rule,
  seatHolding,
  traitRequest,
} from "ponder:schema";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { and, asc, client, count, countDistinct, desc, eq, graphql, gte, lte, sql, sum } from "ponder";
import { settings } from "../settings";

const app = new Hono();

// ---------------------------------------------------------------- CORS

const corsOrigins = (process.env.CORS_ORIGINS || "https://sworn.vibingco.de,https://sworn.sites.imd.fun")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
app.use(
  "*",
  cors({
    origin: (origin) => {
      if (corsOrigins.includes("*")) return "*";
      if (origin && corsOrigins.includes(origin)) return origin;
      // No or unknown Origin: still name an allowed origin so every response carries the header.
      return corsOrigins[0] ?? "*";
    },
    allowMethods: ["GET", "POST", "OPTIONS"],
    maxAge: 86400,
  }),
);

app.use("/graphql", graphql({ db, schema }));
app.use("/sql/*", client({ db, schema }));

// ---------------------------------------------------------------- helpers

/** JSON with bigints as decimal strings, block numbers and timestamps as numbers. */
const NUMERIC_KEYS = new Set([
  "blockNumber", "block", "fromBlock", "toBlock", "mintBlock", "timestamp", "fromTimestamp", "toTimestamp",
  "mintTimestamp", "requestedBlock", "requestedTimestamp", "resolvedBlock", "resolvedTimestamp",
  "firstDepositBlock", "firstDepositTimestamp", "firstDepositIndex", "tokenId", "lastIndexedBlock",
  "settledBlock", "chainHead", "count", "deposits", "contributors", "rank",
]);
const json = (c: Context, body: unknown, status = 200) =>
  c.body(
    JSON.stringify(body, (k, v) =>
      typeof v === "bigint" ? (NUMERIC_KEYS.has(k) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString()) : v,
    ),
    status as 200,
    { "content-type": "application/json; charset=utf-8" },
  );

const isAddress = (a: string | undefined): a is string => !!a && /^0x[0-9a-fA-F]{40}$/.test(a);
const lower = (a: string) => a.toLowerCase() as `0x${string}`;
const rows = (r: unknown): Record<string, unknown>[] =>
  Array.isArray(r) ? (r as Record<string, unknown>[]) : (((r as { rows?: unknown[] }).rows ?? []) as Record<string, unknown>[]);

/** The block every chain-1 contract has been indexed through, from Ponder's own checkpoint table. */
async function indexedState() {
  let lastIndexedBlock: number | null = null;
  let ready = false;
  try {
    const cp = rows(await db.execute(sql`SELECT latest_checkpoint FROM _ponder_checkpoint WHERE chain_id = 1`));
    const checkpoint = cp[0]?.latest_checkpoint as string | undefined;
    // Ponder checkpoint layout: 10 digits timestamp, 16 chain id, 16 block number, ...
    if (checkpoint) lastIndexedBlock = Number(checkpoint.slice(26, 42));
  } catch {}
  try {
    const meta = rows(await db.execute(sql`SELECT value FROM _ponder_meta WHERE key = 'app'`));
    const value = meta[0]?.value as { is_ready?: number } | string | undefined;
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    ready = parsed?.is_ready === 1;
  } catch {}
  return { lastIndexedBlock, ready };
}

// ---------------------------------------------------------------- /health

// The chain head, refreshed in the background so /health never waits on a slow or
// rate-limited RPC; the last value seen is served.
let chainHead: { number: number; seenAt: number } | null = null;
let headInFlight = false;
const refreshHead = () => {
  if (headInFlight || (chainHead && Date.now() - chainHead.seenAt < 10_000)) return;
  headInFlight = true;
  publicClients["mainnet"]
    .getBlockNumber({ cacheTime: 5_000 })
    .then((n) => {
      chainHead = { number: Number(n), seenAt: Date.now() };
    })
    .catch(() => {})
    .finally(() => {
      headInFlight = false;
    });
};

app.get("/health", async (c) => {
  refreshHead();
  const { lastIndexedBlock, ready } = await indexedState();
  const contract = (startBlock: number, endBlock?: number) => ({
    startBlock,
    endBlock: endBlock ?? null,
    // null until the indexer has reached the contract's start block.
    lastIndexedBlock:
      lastIndexedBlock === null || lastIndexedBlock < startBlock
        ? null
        : endBlock !== undefined
          ? Math.min(lastIndexedBlock, endBlock)
          : lastIndexedBlock,
  });
  return json(c, {
    status: "ok",
    chainId: 1,
    chainHead: chainHead?.number ?? null,
    chainHeadSeenAt: chainHead ? new Date(chainHead.seenAt).toISOString() : null,
    lastIndexedBlock,
    backfillComplete: ready,
    contracts: {
      SwornRegistry: { address: settings.registry.address, ...contract(settings.registry.startBlock) },
      ImdToken: { address: settings.imd.address, payee: settings.imd.payee, ...contract(settings.imd.startBlock) },
      WhitelistCurator: {
        address: settings.curator.address,
        ...contract(settings.curator.startBlock, settings.curator.endBlock),
      },
      IdmdSeat: { address: settings.seat.address, ...contract(settings.seat.startBlock) },
    },
  });
});

// ---------------------------------------------------------------- rules

const ruleView = (r: typeof rule.$inferSelect) => ({
  id: r.traitId,
  name: r.name,
  kind: r.kind,
  target: r.target,
  item: r.item,
  arg: r.arg,
  fixedArg: r.fixedArg,
  fixedVal: r.fixedVal,
  fixedValAsAddress: r.fixedVal < 2n ** 160n ? `0x${r.fixedVal.toString(16).padStart(40, "0")}` : null,
  sumArg: r.sumArg,
  op: r.op,
  threshold: r.threshold,
  fromBlock: r.fromBlock,
  toBlock: r.toBlock,
  registrant: r.registrant,
  blockNumber: r.blockNumber,
  timestamp: r.timestamp,
  transactionHash: r.transactionHash,
});

app.get("/rules", async (c) => {
  const all = await db.select().from(rule).orderBy(asc(rule.traitId));
  return json(c, { rules: all.map(ruleView) });
});

/** Comparison ops as the registry encodes them; count `op` threshold. */
const compare = (op: number, value: bigint, threshold: bigint): boolean | null => {
  switch (op) {
    case 0: return value >= threshold;
    case 1: return value > threshold;
    case 2: return value <= threshold;
    case 3: return value < threshold;
    case 4: return value === threshold;
    default: return null;
  }
};

app.get("/rules/:id/eligibility", async (c) => {
  const id = Number(c.req.param("id"));
  const wallet = c.req.query("wallet");
  if (!Number.isInteger(id)) return json(c, { error: "rule id must be an integer" }, 400);
  if (!isAddress(wallet)) return json(c, { error: "wallet query parameter must be a 0x address" }, 400);
  const [r] = await db.select().from(rule).where(eq(rule.traitId, id));
  if (!r) return json(c, { error: `rule ${id} is not registered` }, 404);

  const view = ruleView(r);
  const { lastIndexedBlock } = await indexedState();
  // Supported shape: kind 1, count of IMD Transfer events whose fixed `to` is the payee,
  // counted per sender (`from`).
  const supported =
    r.kind === 1 &&
    r.target === settings.imd.address &&
    // item is the event signature, e.g. "event Transfer(address indexed from, address indexed to, uint256 value)"
    /^(event\s+)?Transfer\s*\(\s*address\s+indexed\s+from\s*,\s*address\s+indexed\s+to\s*,\s*uint256\s+value\s*\)/.test(r.item.trim()) &&
    r.fixedArg === "to" &&
    r.fixedVal === BigInt(settings.imd.payee) &&
    (r.arg === "" || r.arg === "from") &&
    r.sumArg === "" &&
    compare(r.op, 0n, 0n) !== null;
  if (!supported) return json(c, { supported: false, rule: view, lastIndexedBlock });

  const w = lower(wallet);
  const counted = await db
    .select({
      blockNumber: imdPayment.blockNumber,
      logIndex: imdPayment.logIndex,
      transactionHash: imdPayment.transactionHash,
      value: imdPayment.value,
      timestamp: imdPayment.timestamp,
    })
    .from(imdPayment)
    .where(
      and(
        eq(imdPayment.from, w),
        eq(imdPayment.to, settings.imd.payee),
        gte(imdPayment.blockNumber, r.fromBlock),
        lte(imdPayment.blockNumber, r.toBlock),
      ),
    )
    .orderBy(asc(imdPayment.blockNumber), asc(imdPayment.logIndex));
  const n = BigInt(counted.length);
  return json(c, {
    supported: true,
    ruleId: r.traitId,
    name: r.name,
    wallet: w,
    count: counted.length,
    threshold: r.threshold,
    op: r.op,
    met: compare(r.op, n, r.threshold),
    window: { fromBlock: r.fromBlock, toBlock: r.toBlock },
    windowFullyIndexed: lastIndexedBlock !== null && BigInt(lastIndexedBlock) >= r.toBlock,
    lastIndexedBlock,
    transfers: counted,
  });
});

// ---------------------------------------------------------------- wallets, cards, payments

app.get("/wallets/:address", async (c) => {
  const a = c.req.param("address");
  if (!isAddress(a)) return json(c, { error: "address must be a 0x address" }, 400);
  const w = lower(a);
  const [cards, requests, payments] = await Promise.all([
    db.select().from(card).where(eq(card.claimant, w)).orderBy(asc(card.tokenId)),
    db.select().from(traitRequest).where(eq(traitRequest.claimant, w)).orderBy(asc(traitRequest.requestedBlock)),
    db
      .select()
      .from(imdPayment)
      .where(eq(imdPayment.from, w))
      .orderBy(asc(imdPayment.blockNumber), asc(imdPayment.logIndex)),
  ]);
  const held = await db.select().from(card).where(eq(card.holder, w)).orderBy(asc(card.tokenId));
  const { lastIndexedBlock } = await indexedState();
  return json(c, {
    wallet: w,
    card: cards[0] ? { tokenId: cards[0].tokenId, holder: cards[0].holder, mintBlock: cards[0].mintBlock, mintTx: cards[0].mintTx } : null,
    cardsHeld: held.map((k) => k.tokenId),
    requests: requests.map((r) => ({
      traitId: r.traitId,
      requestId: r.requestId,
      state: r.state,
      questionHash: r.questionHash,
      requestedBlock: r.requestedBlock,
      requestedTx: r.requestedTx,
      resolvedBlock: r.resolvedBlock,
      resolvedTx: r.resolvedTx,
      oracleRequestId: r.oracleRequestId,
      missedReason: r.missedReason,
      noVerdict:
        r.state === "noverdict"
          ? { status: r.noVerdictStatus, reason: r.noVerdictReason, agreed: r.noVerdictAgreed, answered: r.noVerdictAnswered }
          : null,
    })),
    verifiedTraits: requests
      .filter((r) => r.state === "verified")
      .map((r) => ({ traitId: r.traitId, requestId: r.requestId, oracleRequestId: r.oracleRequestId, block: r.resolvedBlock })),
    payments: payments.map((p) => ({
      blockNumber: p.blockNumber,
      logIndex: p.logIndex,
      transactionHash: p.transactionHash,
      value: p.value,
      timestamp: p.timestamp,
    })),
    lastIndexedBlock,
  });
});

app.get("/cards", async (c) => {
  const all = await db.select().from(card).orderBy(asc(card.tokenId));
  return json(c, {
    count: all.length,
    cards: all.map((k) => ({
      tokenId: k.tokenId,
      claimant: k.claimant,
      holder: k.holder,
      mintBlock: k.mintBlock,
      mintTimestamp: k.mintTimestamp,
      mintTx: k.mintTx,
    })),
  });
});

app.get("/payments", async (c) => {
  const wallet = c.req.query("wallet");
  if (!isAddress(wallet)) return json(c, { error: "wallet query parameter must be a 0x address" }, 400);
  const from = c.req.query("from");
  const to = c.req.query("to");
  if ((from && !/^\d+$/.test(from)) || (to && !/^\d+$/.test(to)))
    return json(c, { error: "from and to must be block numbers" }, 400);
  const where = [eq(imdPayment.from, lower(wallet))];
  if (from) where.push(gte(imdPayment.blockNumber, BigInt(from)));
  if (to) where.push(lte(imdPayment.blockNumber, BigInt(to)));
  const list = await db
    .select()
    .from(imdPayment)
    .where(and(...where))
    .orderBy(asc(imdPayment.blockNumber), asc(imdPayment.logIndex));
  const { lastIndexedBlock } = await indexedState();
  return json(c, {
    wallet: lower(wallet),
    payee: settings.imd.payee,
    fromBlock: from ? Number(from) : null,
    toBlock: to ? Number(to) : null,
    count: list.length,
    payments: list.map((p) => ({
      blockNumber: p.blockNumber,
      logIndex: p.logIndex,
      transactionHash: p.transactionHash,
      from: p.from,
      value: p.value,
      timestamp: p.timestamp,
    })),
    lastIndexedBlock,
  });
});

// ---------------------------------------------------------------- curator

app.get("/curator/stats", async (c) => {
  const [[contributors], [deposits], [saved], perHour, [late], settled] = await Promise.all([
    db.select({ n: count() }).from(curatorContributor),
    db.select({ n: count() }).from(curatorDeposit),
    db.select({ n: count(), saviors: countDistinct(curatorHourSaved.savior) }).from(curatorHourSaved),
    db
      .select({ hour: curatorDeposit.hour, deposits: count(), total: sum(curatorDeposit.amount), contributors: countDistinct(curatorDeposit.contributor) })
      .from(curatorDeposit)
      .groupBy(curatorDeposit.hour)
      .orderBy(asc(curatorDeposit.hour)),
    db
      .select({ deposits: count(), contributors: countDistinct(curatorDeposit.contributor) })
      .from(curatorDeposit)
      .where(and(gte(curatorDeposit.hour, 24), lte(curatorDeposit.hour, 65))),
    db.select().from(curatorLifecycle).where(eq(curatorLifecycle.event, "Settled")),
  ]);
  const byHour = new Map(perHour.map((h) => [h.hour, h]));
  const hours = [];
  for (let h = 0; h <= 65; h++) {
    const row = byHour.get(h);
    hours.push({ hour: h, deposits: row?.deposits ?? 0, contributors: row?.contributors ?? 0, total: row?.total ?? "0" });
  }
  const s = settled[0];
  return json(c, {
    contributors: contributors?.n ?? 0,
    deposits: deposits?.n ?? 0,
    hourSaved: saved?.n ?? 0,
    distinctSaviors: saved?.saviors ?? 0,
    hours24to65: { deposits: late?.deposits ?? 0, contributors: late?.contributors ?? 0 },
    settled: s ? { block: s.blockNumber, timestamp: s.timestamp, transactionHash: s.transactionHash, args: s.args } : null,
    settledBlock: s?.blockNumber ?? null,
    perHour: hours,
  });
});

app.get("/curator/wallets/:address", async (c) => {
  const a = c.req.param("address");
  if (!isAddress(a)) return json(c, { error: "address must be a 0x address" }, 400);
  const w = lower(a);
  const [[contributor], deposits, saved] = await Promise.all([
    db.select().from(curatorContributor).where(eq(curatorContributor.address, w)),
    db
      .select()
      .from(curatorDeposit)
      .where(eq(curatorDeposit.contributor, w))
      .orderBy(asc(curatorDeposit.blockNumber), asc(curatorDeposit.logIndex)),
    db.select().from(curatorHourSaved).where(eq(curatorHourSaved.savior, w)).orderBy(asc(curatorHourSaved.blockNumber)),
  ]);
  let rank: number | null = null;
  if (contributor) {
    const [above] = await db
      .select({ n: count() })
      .from(curatorContributor)
      .where(sql`${curatorContributor.totalWeightAdded} > ${contributor.totalWeightAdded}`);
    rank = (above?.n ?? 0) + 1;
  }
  return json(c, {
    wallet: w,
    contributor: !!contributor,
    firstDepositIndex: contributor?.firstDepositIndex ?? null,
    firstDepositHour: deposits[0]?.hour ?? null,
    firstDepositBlock: contributor?.firstDepositBlock ?? null,
    firstDepositTimestamp: contributor?.firstDepositTimestamp ?? null,
    depositCount: deposits.length,
    totalAmount: contributor?.totalAmount ?? 0n,
    totalWeightAdded: contributor?.totalWeightAdded ?? 0n,
    rank,
    deposits: deposits.map((d) => ({
      blockNumber: d.blockNumber,
      transactionHash: d.transactionHash,
      hour: d.hour,
      amount: d.amount,
      weightAdded: d.weightAdded,
      newWeight: d.newWeight,
      txCount: d.txCount,
      earlyBps: d.earlyBps,
    })),
    hoursSaved: saved.map((s) => ({ hour: s.hour, hourTotal: s.hourTotal, blockNumber: s.blockNumber, transactionHash: s.transactionHash })),
  });
});

app.get("/curator/top", async (c) => {
  const nRaw = Number(c.req.query("n") ?? 32);
  const n = Number.isInteger(nRaw) && nRaw > 0 ? Math.min(nRaw, 1000) : 32;
  const top = await db
    .select()
    .from(curatorContributor)
    .orderBy(desc(curatorContributor.totalWeightAdded), asc(curatorContributor.firstDepositIndex))
    .limit(n);
  return json(c, {
    n,
    wallets: top.map((t, i) => ({
      rank: i + 1,
      wallet: t.address,
      totalWeightAdded: t.totalWeightAdded,
      depositCount: t.depositCount,
      totalAmount: t.totalAmount,
      firstDepositIndex: t.firstDepositIndex,
    })),
  });
});

// ---------------------------------------------------------------- seats

app.get("/seats/:address", async (c) => {
  const a = c.req.param("address");
  if (!isAddress(a)) return json(c, { error: "address must be a 0x address" }, 400);
  const w = lower(a);
  const holdings = await db
    .select()
    .from(seatHolding)
    .where(eq(seatHolding.holder, w))
    .orderBy(asc(seatHolding.tokenId), asc(seatHolding.fromBlock));
  const byToken = new Map<bigint, (typeof holdings)[number][]>();
  for (const h of holdings) byToken.set(h.tokenId, [...(byToken.get(h.tokenId) ?? []), h]);
  const { lastIndexedBlock } = await indexedState();
  return json(c, {
    wallet: w,
    windowStartBlock: settings.seat.startBlock,
    seats: [...byToken.entries()].map(([tokenId, hs]) => ({
      tokenId,
      holdsNow: hs.some((h) => h.toBlock === null),
      intervals: hs.map((h) => ({
        fromBlock: h.fromBlock,
        fromTimestamp: h.fromTimestamp,
        fromTx: h.fromTx,
        heldBeforeWindowStart: h.seededAtStart,
        toBlock: h.toBlock,
        toTimestamp: h.toTimestamp,
        toTx: h.toTx,
        open: h.toBlock === null,
      })),
    })),
    lastIndexedBlock,
  });
});

app.notFound((c) => json(c, { error: "not found" }, 404));

export default app;
