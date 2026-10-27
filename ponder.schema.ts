import { index, onchainEnum, onchainTable, relations } from "ponder";

// ---------------------------------------------------------------- Sworn registry

/** One Sworn card (ERC-721 minted by CardMinted). `holder` follows Transfer. */
export const card = onchainTable(
  "card",
  (t) => ({
    tokenId: t.bigint().primaryKey(),
    claimant: t.hex().notNull(),
    holder: t.hex().notNull(),
    mintBlock: t.bigint().notNull(),
    mintTimestamp: t.bigint().notNull(),
    mintTx: t.hex().notNull(),
  }),
  (table) => ({ claimantIdx: index().on(table.claimant), holderIdx: index().on(table.holder) }),
);

/** Every ERC-721 Transfer of a Sworn card, mints included. */
export const cardTransfer = onchainTable(
  "card_transfer",
  (t) => ({
    id: t.text().primaryKey(),
    tokenId: t.bigint().notNull(),
    from: t.hex().notNull(),
    to: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    timestamp: t.bigint().notNull(),
    transactionHash: t.hex().notNull(),
  }),
  (table) => ({ tokenIdx: index().on(table.tokenId), toIdx: index().on(table.to), fromIdx: index().on(table.from) }),
);

export const requestState = onchainEnum("request_state", [
  "pending",
  "verified",
  "missed",
  "noverdict",
  "abandoned",
]);

/** One trait request, opened by TraitRequested and closed by Verified, Missed, NoVerdict or Abandoned. */
export const traitRequest = onchainTable(
  "trait_request",
  (t) => ({
    requestId: t.hex().primaryKey(),
    claimant: t.hex().notNull(),
    traitId: t.integer().notNull(),
    questionHash: t.hex().notNull(),
    state: requestState("state").notNull(),
    requestedBlock: t.bigint().notNull(),
    requestedTimestamp: t.bigint().notNull(),
    requestedTx: t.hex().notNull(),
    resolvedBlock: t.bigint(),
    resolvedTimestamp: t.bigint(),
    resolvedTx: t.hex(),
    /** Verified: the oracle's request id. */
    oracleRequestId: t.hex(),
    /** Missed: the reason code. */
    missedReason: t.integer(),
    /** NoVerdict: status, reason, agreed and answered as emitted. */
    noVerdictStatus: t.integer(),
    noVerdictReason: t.hex(),
    noVerdictAgreed: t.integer(),
    noVerdictAnswered: t.integer(),
  }),
  (table) => ({
    claimantIdx: index().on(table.claimant),
    traitIdx: index().on(table.traitId),
    stateIdx: index().on(table.state),
  }),
);

/** One community rule (trait spec), registered by SpecRegistered and read with specOf at that block. */
export const rule = onchainTable("rule", (t) => ({
  traitId: t.integer().primaryKey(),
  registrant: t.hex().notNull(),
  kind: t.integer().notNull(),
  target: t.hex().notNull(),
  item: t.text().notNull(),
  arg: t.text().notNull(),
  fixedArg: t.text().notNull(),
  fixedVal: t.bigint().notNull(),
  sumArg: t.text().notNull(),
  op: t.integer().notNull(),
  threshold: t.bigint().notNull(),
  fromBlock: t.bigint().notNull(),
  toBlock: t.bigint().notNull(),
  name: t.text().notNull(),
  blockNumber: t.bigint().notNull(),
  timestamp: t.bigint().notNull(),
  transactionHash: t.hex().notNull(),
}));

/** SharedFactStored: a shared fact written by a request. */
export const sharedFact = onchainTable(
  "shared_fact",
  (t) => ({
    id: t.text().primaryKey(),
    factId: t.integer().notNull(),
    requestId: t.hex().notNull(),
    length: t.integer().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    transactionHash: t.hex().notNull(),
  }),
  (table) => ({ factIdx: index().on(table.factId) }),
);

/** ERC-4906 MetadataUpdate (fromTokenId = toTokenId) and BatchMetadataUpdate. */
export const metadataUpdate = onchainTable("metadata_update", (t) => ({
  id: t.text().primaryKey(),
  fromTokenId: t.bigint().notNull(),
  toTokenId: t.bigint().notNull(),
  batch: t.boolean().notNull(),
  blockNumber: t.bigint().notNull(),
  timestamp: t.bigint().notNull(),
  transactionHash: t.hex().notNull(),
}));

// ---------------------------------------------------------------- IMD payments

/** IMD ERC-20 Transfer to the swarm's payee. Window counts are queries over these rows. */
export const imdPayment = onchainTable(
  "imd_payment",
  (t) => ({
    id: t.text().primaryKey(),
    from: t.hex().notNull(),
    to: t.hex().notNull(),
    value: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    timestamp: t.bigint().notNull(),
    transactionHash: t.hex().notNull(),
  }),
  (table) => ({
    fromBlockIdx: index().on(table.from, table.blockNumber),
    blockIdx: index().on(table.blockNumber),
  }),
);

// ---------------------------------------------------------------- WhitelistCurator

/** Deposited: one deposit into the curator game. */
export const curatorDeposit = onchainTable(
  "curator_deposit",
  (t) => ({
    id: t.text().primaryKey(),
    contributor: t.hex().notNull(),
    hour: t.integer().notNull(),
    amount: t.bigint().notNull(),
    creditedDelta: t.bigint().notNull(),
    weightAdded: t.bigint().notNull(),
    newWeight: t.bigint().notNull(),
    txCount: t.bigint().notNull(),
    hourTotal: t.bigint().notNull(),
    earlyBps: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    timestamp: t.bigint().notNull(),
    transactionHash: t.hex().notNull(),
  }),
  (table) => ({
    contributorIdx: index().on(table.contributor),
    hourIdx: index().on(table.hour),
  }),
);

/** One curator contributor: FirstDeposit plus running sums over its Deposited events. */
export const curatorContributor = onchainTable(
  "curator_contributor",
  (t) => ({
    address: t.hex().primaryKey(),
    firstDepositIndex: t.bigint(),
    firstDepositTimestamp: t.bigint(),
    firstDepositBlock: t.bigint(),
    firstHour: t.integer(),
    depositCount: t.integer().notNull(),
    totalAmount: t.bigint().notNull(),
    totalWeightAdded: t.bigint().notNull(),
    lastWeight: t.bigint().notNull(),
  }),
  (table) => ({ weightIdx: index().on(table.totalWeightAdded) }),
);

/** HourSaved: a savior pushed an hour over its threshold. */
export const curatorHourSaved = onchainTable(
  "curator_hour_saved",
  (t) => ({
    id: t.text().primaryKey(),
    savior: t.hex().notNull(),
    hour: t.integer().notNull(),
    hourTotal: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    transactionHash: t.hex().notNull(),
  }),
  (table) => ({ saviorIdx: index().on(table.savior) }),
);

/** Launched, Settled and Rescued: the game's lifecycle, one row per event. */
export const curatorLifecycle = onchainTable("curator_lifecycle", (t) => ({
  id: t.text().primaryKey(),
  event: t.text().notNull(),
  /** Launched: launchTime, hourlyThreshold, ...; Settled: hour, timestamp, totals; Rescued: to, amount. JSON of the args, bigints as strings. */
  args: t.json().notNull(),
  blockNumber: t.bigint().notNull(),
  timestamp: t.bigint().notNull(),
  transactionHash: t.hex().notNull(),
}));

// ---------------------------------------------------------------- IDMD seats

/** One IDMD seat with its current holder. */
export const seat = onchainTable(
  "seat",
  (t) => ({
    tokenId: t.bigint().primaryKey(),
    holder: t.hex().notNull(),
    openHoldingId: t.text(),
  }),
  (table) => ({ holderIdx: index().on(table.holder) }),
);

/**
 * Who held which seat when. toBlock null means the holding is open.
 * seededAtStart: the wallet already held the seat at the window start (ownerOf
 * read at startBlock - 1), so fromBlock is the window start, not the acquisition.
 */
export const seatHolding = onchainTable(
  "seat_holding",
  (t) => ({
    id: t.text().primaryKey(),
    tokenId: t.bigint().notNull(),
    holder: t.hex().notNull(),
    fromBlock: t.bigint().notNull(),
    fromTimestamp: t.bigint().notNull(),
    fromTx: t.hex(),
    seededAtStart: t.boolean().notNull(),
    toBlock: t.bigint(),
    toTimestamp: t.bigint(),
    toTx: t.hex(),
  }),
  (table) => ({ holderIdx: index().on(table.holder), tokenIdx: index().on(table.tokenId) }),
);

/** Every IDMD Transfer since the window start. */
export const seatTransfer = onchainTable(
  "seat_transfer",
  (t) => ({
    id: t.text().primaryKey(),
    tokenId: t.bigint().notNull(),
    from: t.hex().notNull(),
    to: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    timestamp: t.bigint().notNull(),
    transactionHash: t.hex().notNull(),
  }),
  (table) => ({ tokenIdx: index().on(table.tokenId), toIdx: index().on(table.to), fromIdx: index().on(table.from) }),
);

// ---------------------------------------------------------------- relations (GraphQL)

export const cardRelations = relations(card, ({ many }) => ({ transfers: many(cardTransfer) }));
export const cardTransferRelations = relations(cardTransfer, ({ one }) => ({
  card: one(card, { fields: [cardTransfer.tokenId], references: [card.tokenId] }),
}));
export const traitRequestRelations = relations(traitRequest, ({ one }) => ({
  rule: one(rule, { fields: [traitRequest.traitId], references: [rule.traitId] }),
}));
export const ruleRelations = relations(rule, ({ many }) => ({ requests: many(traitRequest) }));
export const curatorContributorRelations = relations(curatorContributor, ({ many }) => ({
  deposits: many(curatorDeposit),
}));
export const curatorDepositRelations = relations(curatorDeposit, ({ one }) => ({
  contributorRow: one(curatorContributor, {
    fields: [curatorDeposit.contributor],
    references: [curatorContributor.address],
  }),
}));
export const seatRelations = relations(seat, ({ many }) => ({ holdings: many(seatHolding) }));
export const seatHoldingRelations = relations(seatHolding, ({ one }) => ({
  seat: one(seat, { fields: [seatHolding.tokenId], references: [seat.tokenId] }),
}));
