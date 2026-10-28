import { deriveCoinPolicy } from "./coin_policy.ts";
import { summarizeIntent } from "./intent_state.ts";
import { observationsAreStale, STALE_OBSERVATIONS_WARNING } from "./observation_freshness.ts";
import type { WalletLockState, WalletPublicState, WalletSnapshot } from "./types.ts";
import { canIssueNextReceiveAddress } from "./wallet_sync.ts";

/** Build the immutable, UI-facing view without exposing persisted safety state. */
export function buildWalletSnapshot(
  state: WalletPublicState,
  lockState: WalletLockState,
): WalletSnapshot {
  const policies = state.coins.map((coin) =>
    deriveCoinPolicy(
      coin,
      Boolean(state.sharedProvenance[coin.outpoint]),
      state.intents,
      state.settings,
    )
  );
  const outputs = policies.map((policy) => policy.output);
  const receiveIndex = Math.max(0, state.nextReceiveIndex - 1);
  const receiveAddress = state.recoveryScanComplete
    ? state.addresses.find((address) => address.branch === 0 && address.index === receiveIndex)
    : undefined;
  const canCreateReceiveAddress = lockState === "unlocked" && state.recoveryScanComplete &&
    canIssueNextReceiveAddress(state);
  const ecx = outputs.reduce(
    (total, output) => total + (output.ecx.tx?.present && output.ecx.unspent ? output.value : 0),
    0,
  );
  const btc = outputs.reduce(
    (total, output) => total + (output.btc.tx?.present && output.btc.unspent ? output.value : 0),
    0,
  );
  const selectableEcxOutpoints = policies.filter((policy) => policy.ecxSelectable)
    .map((policy) => policy.output.outpoint);
  const selectableBtcOutpoints = policies.filter((policy) => policy.btcSelectable)
    .map((policy) => policy.output.outpoint);
  const splittableOutpoints = policies.filter((policy) => policy.splittable)
    .map((policy) => policy.output.outpoint);
  const replayCandidateTxids = state.recoveryScanComplete
    ? [
      ...new Set(
        policies.filter((policy) => policy.replayCandidate).map((policy) => policy.output.txid),
      ),
    ]
    : [];
  const ecxSet = new Set(selectableEcxOutpoints);
  const btcSet = new Set(selectableBtcOutpoints);
  const sharedSet = new Set(splittableOutpoints);
  const spendableEcx = outputs.reduce(
    (total, output) => total + (ecxSet.has(output.outpoint) ? output.value : 0),
    0,
  );
  const spendableBtc = outputs.reduce(
    (total, output) => total + (btcSet.has(output.outpoint) ? output.value : 0),
    0,
  );
  const shared = outputs.reduce(
    (total, output) => total + (sharedSet.has(output.outpoint) ? output.value : 0),
    0,
  );
  const hasUnspentOutput = outputs.some((output) =>
    output.ecx.unspent === true || output.btc.unspent === true
  );
  const stale = observationsAreStale(state.lastSyncAt, hasUnspentOutput);
  const warnings = [
    ...(!state.settings.forkCheckpoint
      ? [
        "Network configuration is unavailable. Install a wallet release configured for the intended network before syncing or spending.",
      ]
      : []),
    ...(stale ? [STALE_OBSERVATIONS_WARNING] : []),
    ...(!state.recoveryScanComplete
      ? [`Recovery scan is in progress at address index ${state.recoveryScan?.nextIndex ?? 0}.`]
      : []),
    ...(state.lastSyncError ? [`Last sync: ${state.lastSyncError}`] : []),
  ];
  const {
    coins: _coins,
    sharedProvenance: _provenance,
    intents: _intents,
    ...publicState
  } = structuredClone(state);
  return {
    ...publicState,
    lockState,
    receiveAddress: receiveAddress ? structuredClone(receiveAddress) : undefined,
    canCreateReceiveAddress,
    outputs,
    intents: state.intents.map((intent) =>
      summarizeIntent(intent, state.intents, state.sharedProvenance)
    ),
    balances: { ecx, btc, spendableEcx, spendableBtc, shared },
    selectableEcxOutpoints,
    selectableBtcOutpoints,
    splittableOutpoints,
    replayCandidateTxids,
    warnings,
  };
}
