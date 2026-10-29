import type { EsploraClient } from "./esplora.ts";
import type { ChainId, ChainTip } from "./types.ts";

/** Independently verified hashes at the same height after BTC and ECX diverge. */
export interface ForkCheckpoint {
  height: number;
  btcHash: string;
  ecxHash: string;
}

export function validForkCheckpoint(value: unknown): value is ForkCheckpoint {
  if (!value || typeof value !== "object") return false;
  const checkpoint = value as ForkCheckpoint;
  return Number.isSafeInteger(checkpoint.height) && checkpoint.height > 0 &&
    checkpoint.height < 499_999_998 &&
    typeof checkpoint.btcHash === "string" && /^[0-9a-f]{64}$/.test(checkpoint.btcHash) &&
    typeof checkpoint.ecxHash === "string" && /^[0-9a-f]{64}$/.test(checkpoint.ecxHash) &&
    checkpoint.btcHash !== checkpoint.ecxHash;
}

/** Check the pinned network identity; never learn a checkpoint from the backend being checked. */
export class ChainVerifier {
  async verifiedTip(
    chain: ChainId,
    client: EsploraClient,
    checkpoint?: ForkCheckpoint,
  ): Promise<ChainTip> {
    if (!validForkCheckpoint(checkpoint)) {
      throw new Error(
        "Network configuration is unavailable. Install a wallet release configured for the intended network.",
      );
    }
    const height = await client.tipHeight();
    if (height < checkpoint.height) {
      throw new Error(`${chain.toUpperCase()} backend is behind the required fork checkpoint`);
    }
    const hash = checkpoint[`${chain}Hash`];
    // A backend can switch chains at the same URL between operations.
    const actual = await client.blockHash(checkpoint.height);
    if (actual !== hash) {
      throw new Error(`${chain.toUpperCase()} backend failed the fork checkpoint`);
    }
    return { height, fetchedAt: new Date().toISOString() };
  }
}
