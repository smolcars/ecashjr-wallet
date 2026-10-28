import type { ForkCheckpoint } from "./chain_verifier.ts";

// ECX betanet: https://github.com/ecash-com/fast-facts/blob/main/04-explorers-and-apis.md
// Checked 2026-10-12 against explorer.beta.ecash.ninja and esplora.beta.ecash.ninja.
// Fork height and BTC hash also match ecash-com/ecash-splitter commit
// bfa996779d5b87d09ee159debe7688905db99b47 (ecx-core / ecx-chain).
// BTC hash independently matched mempool.space and blockstream.info at the same height.
export const BETA_FORK_CHECKPOINT: Readonly<ForkCheckpoint> = Object.freeze({
  height: 967_680,
  btcHash: "0000000000000000000161354016172f2a377610d52dd46d0f68a919333458cd",
  ecxHash: "00000000000000030101ba5cfea54b22becc79f95dc6040beb76e01dd9d04042",
});
export const BETA_API_URL = "https://explorer.beta.ecash.ninja/api";

export function isBetaCheckpoint(checkpoint?: ForkCheckpoint): boolean {
  return checkpoint?.height === BETA_FORK_CHECKPOINT.height &&
    checkpoint.btcHash === BETA_FORK_CHECKPOINT.btcHash &&
    checkpoint.ecxHash === BETA_FORK_CHECKPOINT.ecxHash;
}
