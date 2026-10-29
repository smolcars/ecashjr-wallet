import { deepStrictEqual, equal } from "node:assert/strict";
import { MAINNET_API_URL, MAINNET_FORK_CHECKPOINT } from "./network.ts";
import { emptyPublicState } from "./types.ts";

Deno.test("new wallets default to a pinned mainnet network with independently cloned settings", () => {
  const first = emptyPublicState();
  const second = emptyPublicState();
  equal(first.settings.ecxApiUrl, MAINNET_API_URL);
  equal(first.settings.btcApiUrl, "https://mempool.space/api");
  equal(first.settings.forkCheckpoint!.height, 973_728);
  deepStrictEqual(first.settings.forkCheckpoint, MAINNET_FORK_CHECKPOINT);
  first.settings.forkCheckpoint!.height++;
  deepStrictEqual(second.settings.forkCheckpoint, MAINNET_FORK_CHECKPOINT);
});
