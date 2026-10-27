import { ponder } from "ponder:registry";
import { curatorContributor, curatorDeposit, curatorHourSaved, curatorLifecycle } from "ponder:schema";

const jsonArgs = (args: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));

ponder.on("WhitelistCurator:Deposited", async ({ event, context }) => {
  const a = event.args;
  const hour = Number(a.hour);
  await context.db.insert(curatorDeposit).values({
    id: event.id,
    contributor: a.contributor,
    hour,
    amount: a.amount,
    creditedDelta: a.creditedDelta,
    weightAdded: a.weightAdded,
    newWeight: a.newWeight,
    txCount: a.txCount,
    hourTotal: a.hourTotal,
    earlyBps: a.earlyBps,
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    timestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
  });
  await context.db
    .insert(curatorContributor)
    .values({
      address: a.contributor,
      firstHour: hour,
      depositCount: 1,
      totalAmount: a.amount,
      totalWeightAdded: a.weightAdded,
      lastWeight: a.newWeight,
    })
    .onConflictDoUpdate((row) => ({
      firstHour: row.firstHour ?? hour,
      depositCount: row.depositCount + 1,
      totalAmount: row.totalAmount + a.amount,
      totalWeightAdded: row.totalWeightAdded + a.weightAdded,
      lastWeight: a.newWeight,
    }));
});

ponder.on("WhitelistCurator:FirstDeposit", async ({ event, context }) => {
  const first = {
    firstDepositIndex: event.args.index,
    firstDepositTimestamp: event.args.timestamp,
    firstDepositBlock: event.block.number,
  };
  await context.db
    .insert(curatorContributor)
    .values({
      address: event.args.contributor,
      ...first,
      depositCount: 0,
      totalAmount: 0n,
      totalWeightAdded: 0n,
      lastWeight: 0n,
    })
    .onConflictDoUpdate(first);
});

ponder.on("WhitelistCurator:HourSaved", async ({ event, context }) => {
  await context.db.insert(curatorHourSaved).values({
    id: event.id,
    savior: event.args.savior,
    hour: Number(event.args.hour),
    hourTotal: event.args.hourTotal,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
  });
});

for (const name of ["Launched", "Settled", "Rescued"] as const) {
  ponder.on(`WhitelistCurator:${name}`, async ({ event, context }) => {
    await context.db.insert(curatorLifecycle).values({
      id: event.id,
      event: name,
      args: jsonArgs(event.args as Record<string, unknown>),
      blockNumber: event.block.number,
      timestamp: event.block.timestamp,
      transactionHash: event.transaction.hash,
    });
  });
}
