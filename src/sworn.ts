import { ponder } from "ponder:registry";
import { card, cardTransfer, metadataUpdate, rule, sharedFact, traitRequest } from "ponder:schema";
import { SwornRegistryAbi } from "../abis/SwornRegistryAbi";

ponder.on("SwornRegistry:CardMinted", async ({ event, context }) => {
  await context.db
    .insert(card)
    .values({
      tokenId: event.args.tokenId,
      claimant: event.args.claimant,
      holder: event.args.claimant,
      mintBlock: event.block.number,
      mintTimestamp: event.block.timestamp,
      mintTx: event.transaction.hash,
    })
    .onConflictDoUpdate({
      claimant: event.args.claimant,
      mintBlock: event.block.number,
      mintTimestamp: event.block.timestamp,
      mintTx: event.transaction.hash,
    });
});

ponder.on("SwornRegistry:Transfer", async ({ event, context }) => {
  const { from, to, tokenId } = event.args;
  await context.db.insert(cardTransfer).values({
    id: event.id,
    tokenId,
    from,
    to,
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    timestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
  });
  // The mint Transfer may precede CardMinted in the same transaction: create the
  // row with the recipient as provisional claimant; CardMinted then fills it in.
  await context.db
    .insert(card)
    .values({
      tokenId,
      claimant: to,
      holder: to,
      mintBlock: event.block.number,
      mintTimestamp: event.block.timestamp,
      mintTx: event.transaction.hash,
    })
    .onConflictDoUpdate({ holder: to });
});

ponder.on("SwornRegistry:TraitRequested", async ({ event, context }) => {
  await context.db
    .insert(traitRequest)
    .values({
      requestId: event.args.requestId,
      claimant: event.args.claimant,
      traitId: event.args.traitId,
      questionHash: event.args.questionHash,
      state: "pending",
      requestedBlock: event.block.number,
      requestedTimestamp: event.block.timestamp,
      requestedTx: event.transaction.hash,
    })
    .onConflictDoNothing();
});

const resolved = (event: { block: { number: bigint; timestamp: bigint }; transaction: { hash: `0x${string}` } }) => ({
  resolvedBlock: event.block.number,
  resolvedTimestamp: event.block.timestamp,
  resolvedTx: event.transaction.hash,
});

ponder.on("SwornRegistry:Verified", async ({ event, context }) => {
  await context.db
    .insert(traitRequest)
    .values({
      requestId: event.args.requestId,
      claimant: event.args.claimant,
      traitId: event.args.traitId,
      questionHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      state: "verified",
      requestedBlock: event.block.number,
      requestedTimestamp: event.block.timestamp,
      requestedTx: event.transaction.hash,
      oracleRequestId: event.args.oracleRequestId,
      ...resolved(event),
    })
    .onConflictDoUpdate({ state: "verified", oracleRequestId: event.args.oracleRequestId, ...resolved(event) });
});

ponder.on("SwornRegistry:Missed", async ({ event, context }) => {
  const row = await context.db.find(traitRequest, { requestId: event.args.requestId });
  if (!row) return; // a request this indexer never saw opened (cannot happen from the deployment block)
  await context.db
    .update(traitRequest, { requestId: event.args.requestId })
    .set({ state: "missed", missedReason: event.args.reason, ...resolved(event) });
});

ponder.on("SwornRegistry:NoVerdict", async ({ event, context }) => {
  const row = await context.db.find(traitRequest, { requestId: event.args.requestId });
  if (!row) return;
  await context.db.update(traitRequest, { requestId: event.args.requestId }).set({
    state: "noverdict",
    noVerdictStatus: event.args.status,
    noVerdictReason: event.args.reason,
    noVerdictAgreed: event.args.agreed,
    noVerdictAnswered: event.args.answered,
    ...resolved(event),
  });
});

ponder.on("SwornRegistry:Abandoned", async ({ event, context }) => {
  const row = await context.db.find(traitRequest, { requestId: event.args.requestId });
  if (!row) return;
  await context.db
    .update(traitRequest, { requestId: event.args.requestId })
    .set({ state: "abandoned", ...resolved(event) });
});

ponder.on("SwornRegistry:SpecRegistered", async ({ event, context }) => {
  // The event carries only the id and registrant; the rule itself is read with
  // specOf at the registration block (one RPC call per registered rule).
  // Retried: with several RPCs configured, one that is not archive for state (it
  // answers "historical state is not available") must not stop the indexer.
  let spec;
  for (let attempt = 1; ; attempt++) {
    try {
      spec = await context.client.readContract({
        abi: SwornRegistryAbi,
        address: event.log.address,
        functionName: "specOf",
        args: [event.args.traitId],
        blockNumber: event.block.number,
      });
      break;
    } catch (error) {
      if (attempt >= 8) throw error;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  const values = {
    registrant: event.args.registrant,
    kind: spec.kind,
    target: spec.target.toLowerCase() as `0x${string}`,
    item: spec.item,
    arg: spec.arg,
    fixedArg: spec.fixedArg,
    fixedVal: spec.fixedVal,
    sumArg: spec.sumArg,
    op: spec.op,
    threshold: spec.threshold,
    fromBlock: spec.fromBlock,
    toBlock: spec.toBlock,
    name: spec.name,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
  };
  await context.db
    .insert(rule)
    .values({ traitId: event.args.traitId, ...values })
    .onConflictDoUpdate(values);
});

ponder.on("SwornRegistry:SharedFactStored", async ({ event, context }) => {
  await context.db.insert(sharedFact).values({
    id: event.id,
    factId: event.args.factId,
    requestId: event.args.requestId,
    length: event.args.length,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
  });
});

ponder.on("SwornRegistry:MetadataUpdate", async ({ event, context }) => {
  await context.db.insert(metadataUpdate).values({
    id: event.id,
    fromTokenId: event.args.tokenId,
    toTokenId: event.args.tokenId,
    batch: false,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
  });
});

ponder.on("SwornRegistry:BatchMetadataUpdate", async ({ event, context }) => {
  await context.db.insert(metadataUpdate).values({
    id: event.id,
    fromTokenId: event.args.fromTokenId,
    toTokenId: event.args.toTokenId,
    batch: true,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
  });
});
