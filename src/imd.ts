import { ponder } from "ponder:registry";
import { imdPayment } from "ponder:schema";

// Only Transfers to the payee reach this handler (the filter is in ponder.config.ts).
ponder.on("ImdToken:Transfer", async ({ event, context }) => {
  await context.db.insert(imdPayment).values({
    id: event.id,
    from: event.args.from,
    to: event.args.to,
    value: event.args.value,
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    timestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
  });
});
