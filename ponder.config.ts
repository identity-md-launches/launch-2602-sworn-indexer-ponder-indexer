import { createConfig } from "ponder";
import { Erc20TransferAbi } from "./abis/Erc20TransferAbi";
import { Erc721SeatAbi } from "./abis/Erc721SeatAbi";
import { SwornRegistryAbi } from "./abis/SwornRegistryAbi";
import { WhitelistCuratorAbi } from "./abis/WhitelistCuratorAbi";
import { settings } from "./src/settings";

// PONDER_RPC_URL_1 may hold several endpoints separated by commas; Ponder then
// load-balances and fails over between them.
const rpcUrls = (process.env.PONDER_RPC_URL_1 ?? "")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);
if (rpcUrls.length === 0) {
  throw new Error("PONDER_RPC_URL_1 is required (an Ethereum mainnet archive RPC; see env.example)");
}

const databaseUrl = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;

export default createConfig({
  database: databaseUrl
    ? { kind: "postgres", connectionString: databaseUrl }
    : { kind: "pglite", directory: process.env.PGLITE_DIRECTORY || ".ponder/pglite" },
  ordering: "multichain",
  chains: {
    mainnet: {
      id: 1,
      rpc: rpcUrls.length === 1 ? rpcUrls[0]! : rpcUrls,
      ws: process.env.PONDER_WS_URL_1 || undefined,
      ethGetLogsBlockRange: settings.getLogsBlockRange,
      pollingInterval: settings.pollingIntervalMs,
    },
  },
  contracts: {
    // Sworn registry: cards (ERC-721), trait requests and their outcomes, community rules.
    SwornRegistry: {
      abi: SwornRegistryAbi,
      chain: "mainnet",
      address: settings.registry.address,
      startBlock: settings.registry.startBlock,
    },
    // IMD token, only Transfers whose `to` is the swarm's payee (filtered in eth_getLogs).
    ImdToken: {
      abi: Erc20TransferAbi,
      chain: "mainnet",
      address: settings.imd.address,
      startBlock: settings.imd.startBlock,
      filter: { event: "Transfer", args: { to: settings.imd.payee } },
    },
    // Settled WhitelistCurator game: nothing changes after the Settled block.
    WhitelistCurator: {
      abi: WhitelistCuratorAbi,
      chain: "mainnet",
      address: settings.curator.address,
      startBlock: settings.curator.startBlock,
      endBlock: settings.curator.endBlock,
    },
    // IdentityMD seat collection (IDMD), Transfers from the Swarmed window start.
    IdmdSeat: {
      abi: Erc721SeatAbi,
      chain: "mainnet",
      address: settings.seat.address,
      startBlock: settings.seat.startBlock,
    },
  },
});
