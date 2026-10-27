// Every address, start block and tunable comes from the environment, with the
// mainnet deployment as the default. Shared by ponder.config.ts and the API.

const addr = (name: string, fallback: string) =>
  (process.env[name] || fallback).toLowerCase() as `0x${string}`;
const int = (name: string, fallback: number) => {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : Number(v);
};
const optInt = (name: string) => {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : Number(v);
};

export const settings = {
  registry: {
    address: addr("SWORN_REGISTRY_ADDRESS", "0x0da2679000ea5380d1361cc3cca7d4e8c881f766"),
    startBlock: int("SWORN_REGISTRY_START_BLOCK", 26_242_885),
  },
  imd: {
    address: addr("IMD_TOKEN_ADDRESS", "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7"),
    payee: addr("IMD_PAYEE_ADDRESS", "0x4e0fa57bde726079356537e2f34d671e9f41adbc"),
    startBlock: int("IMD_TOKEN_START_BLOCK", 26_038_414),
  },
  curator: {
    address: addr("CURATOR_ADDRESS", "0xcb0b0531e86a9ac36fa865ca8e3dbccf047fda91"),
    startBlock: int("CURATOR_START_BLOCK", 25_769_870),
    endBlock: int("CURATOR_END_BLOCK", 25_789_721),
  },
  seat: {
    address: addr("IDMD_SEAT_ADDRESS", "0x0000eC93127BAA929E58E97dd0095A2BFb38ec1D"),
    startBlock: int("IDMD_SEAT_START_BLOCK", 25_090_085),
  },
  // Largest eth_getLogs span Ponder asks for. Ponder shrinks it when an RPC answers
  // "range too large", but Tenderly's public gateway answers a range with more than
  // 20,000 logs with "invalid params" (the hint is only in error.data), which Ponder
  // retries unchanged; the curator game reaches ~12,600 logs in 2,000 blocks. Ponder
  // also holds every full block of an interval in memory while it syncs it, so the
  // span bounds memory too: 500 keeps the container under 512 MB.
  getLogsBlockRange: optInt("PONDER_GETLOGS_BLOCK_RANGE") ?? 500,
  pollingIntervalMs: int("PONDER_POLLING_INTERVAL_MS", 4_000),
  multicall3: addr("MULTICALL3_ADDRESS", "0xcA11bde05977b3631167028862bE2a173976CA11"),
} as const;
