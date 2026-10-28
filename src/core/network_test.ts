import { deepStrictEqual, equal } from "node:assert/strict";
import { BETA_API_URL, BETA_FORK_CHECKPOINT, isBetaCheckpoint } from "./network.ts";
import { emptyPublicState } from "./types.ts";
import { parseWalletState } from "./storage.ts";

function prelaunchState() {
  const state = emptyPublicState();
  delete state.settings.forkCheckpoint;
  state.settings.ecxApiUrl = "https://explorer.ecash.com/api";
  state.lastSyncError = "ECX: Mainnet fork checkpoint is not configured";
  return state;
}

Deno.test("new wallets default to a pinned beta network with independently cloned settings", () => {
  const first = emptyPublicState();
  const second = emptyPublicState();
  equal(first.settings.ecxApiUrl, BETA_API_URL);
  equal(first.settings.btcApiUrl, "https://mempool.space/api");
  equal(first.settings.forkCheckpoint!.height, 967_680);
  deepStrictEqual(first.settings.forkCheckpoint, BETA_FORK_CHECKPOINT);
  first.settings.forkCheckpoint!.height++;
  deepStrictEqual(second.settings.forkCheckpoint, BETA_FORK_CHECKPOINT);
  equal(isBetaCheckpoint(first.settings.forkCheckpoint), false);
  // A tip beyond the planned mainnet height must not upgrade beta to mainnet.
  second.tips.ecx = { height: 1_000_000, fetchedAt: new Date().toISOString() };
  equal(isBetaCheckpoint(second.settings.forkCheckpoint), true);
});

Deno.test("unused prelaunch wallets adopt beta without modifying the loaded record", () => {
  const old = prelaunchState();
  const parsed = parseWalletState(old);
  deepStrictEqual(parsed.settings.forkCheckpoint, BETA_FORK_CHECKPOINT);
  equal(parsed.settings.ecxApiUrl, BETA_API_URL);
  equal(parsed.lastSyncError, undefined);
  equal(old.settings.forkCheckpoint, undefined);
  equal(old.settings.ecxApiUrl, "https://explorer.ecash.com/api");
  deepStrictEqual(parseWalletState(parsed), parsed);
});

Deno.test("beta migration preserves explicit network pins, custom endpoints, and chain history", () => {
  const pinned = prelaunchState();
  pinned.settings.forkCheckpoint = {
    height: 970_000,
    btcHash: "11".repeat(32),
    ecxHash: "22".repeat(32),
  };
  deepStrictEqual(parseWalletState(pinned).settings, pinned.settings);
  const custom = prelaunchState();
  custom.settings.ecxApiUrl = "https://example.com/api";
  deepStrictEqual(parseWalletState(custom).settings, custom.settings);
  const observed = prelaunchState();
  observed.tips.ecx = { height: 970_000, fetchedAt: new Date().toISOString() };
  deepStrictEqual(parseWalletState(observed).settings, observed.settings);
  const shared = prelaunchState();
  shared.sharedProvenance[`${"11".repeat(32)}:0`] = { firstObservedAt: new Date().toISOString() };
  deepStrictEqual(parseWalletState(shared).settings, shared.settings);
});
