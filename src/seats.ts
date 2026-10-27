import { ponder } from "ponder:registry";
import { seat, seatHolding, seatTransfer } from "ponder:schema";
import { Erc721SeatAbi } from "../abis/Erc721SeatAbi";
import { settings } from "./settings";

const ZERO = "0x0000000000000000000000000000000000000000";

// If IDMD_SEAT_START_BLOCK is set after the deployment, seats minted earlier have
// holders the window's Transfers never name. Read ownerOf for every token at startBlock - 1 (multicall, a handful of
// RPC calls) and open a holding for each, marked seededAtStart.
ponder.on("IdmdSeat:setup", async ({ context }) => {
  const blockNumber = BigInt(settings.seat.startBlock - 1);
  const address = settings.seat.address;
  // On mainnet the collection was deployed at the window start itself, so there is
  // nothing to seed: every seat's mint Transfer is inside the indexed range.
  const code = await context.client.getCode({ address, blockNumber });
  if (!code || code === "0x") return;
  const supply = await context.client.readContract({
    abi: Erc721SeatAbi,
    address,
    functionName: "totalSupply",
    blockNumber,
  });
  const block = await context.client.getBlock({ blockNumber });
  const ids: bigint[] = [];
  // Token ids may start at 0 or 1: probe 0..supply and keep the ones that exist.
  for (let i = 0n; i <= supply; i++) ids.push(i);
  for (let i = 0; i < ids.length; i += 250) {
    const batch = ids.slice(i, i + 250);
    const owners = await context.client.multicall({
      contracts: batch.map((tokenId) => ({
        abi: Erc721SeatAbi,
        address,
        functionName: "ownerOf" as const,
        args: [tokenId] as const,
      })),
      allowFailure: true,
      blockNumber,
      multicallAddress: settings.multicall3,
    });
    for (let j = 0; j < batch.length; j++) {
      const r = owners[j]!;
      if (r.status !== "success") continue;
      const holder = (r.result as string).toLowerCase() as `0x${string}`;
      if (holder === ZERO) continue;
      const tokenId = batch[j]!;
      const id = `${tokenId}-seed`;
      await context.db.insert(seatHolding).values({
        id,
        tokenId,
        holder,
        fromBlock: BigInt(settings.seat.startBlock),
        fromTimestamp: block.timestamp,
        seededAtStart: true,
      });
      await context.db.insert(seat).values({ tokenId, holder, openHoldingId: id });
    }
  }
});

ponder.on("IdmdSeat:Transfer", async ({ event, context }) => {
  const { from, to, tokenId } = event.args;
  await context.db.insert(seatTransfer).values({
    id: event.id,
    tokenId,
    from,
    to,
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    timestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
  });

  const current = await context.db.find(seat, { tokenId });
  if (current?.openHoldingId) {
    await context.db.update(seatHolding, { id: current.openHoldingId }).set({
      toBlock: event.block.number,
      toTimestamp: event.block.timestamp,
      toTx: event.transaction.hash,
    });
  }

  let openHoldingId: string | null = null;
  if (to !== ZERO) {
    openHoldingId = `${tokenId}-${event.block.number}-${event.log.logIndex}`;
    await context.db.insert(seatHolding).values({
      id: openHoldingId,
      tokenId,
      holder: to,
      fromBlock: event.block.number,
      fromTimestamp: event.block.timestamp,
      fromTx: event.transaction.hash,
      seededAtStart: false,
    });
  }
  await context.db
    .insert(seat)
    .values({ tokenId, holder: to, openHoldingId })
    .onConflictDoUpdate({ holder: to, openHoldingId });
});
