import type { ForkCheckpoint } from "./chain_verifier.ts";

// Mainnet fork block, verified 2026-10-29.
// BTC: https://mempool.space/api/block-height/973728
//      https://blockstream.info/api/block-height/973728
// ECX: https://explorer.ecash.com/api/block-height/973728
export const MAINNET_FORK_CHECKPOINT: Readonly<ForkCheckpoint> = Object.freeze({
  height: 973_728,
  btcHash: "0000000000000000000104150b08ff89bbb2d11bab42c245c82b8165ab2e2c11",
  ecxHash: "0000000000000001441a6a4ae49d679d4a30581db3e3eaeeb2fba5da6dc146ed",
});
export const MAINNET_API_URL = "https://explorer.ecash.com/api";
