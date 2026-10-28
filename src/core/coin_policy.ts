import { intentBlocksOutpoint, splitProvidesConfirmedProtection } from "./intent_state.ts";
import type {
  ChainCoinObservation,
  ChainId,
  PersistedCoin,
  SpendRisk,
  SplitState,
  TrackedOutput,
  TransactionIntent,
  WalletSettings,
} from "./types.ts";

export interface CoinPolicy {
  output: TrackedOutput;
  ecxSelectable: boolean;
  btcSelectable: boolean;
  splittable: boolean;
  replayCandidate: boolean;
  btcRisks: SpendRisk[];
  btcReplayProtectionSplitIntentIds: string[];
}

export interface SpendAuthorization {
  splitInputCount: number;
  splitOutpoints: string[];
  risks: SpendRisk[];
  replayProtectionSplitIntentIds: string[];
}

function observationIsSpendable(
  observation: ChainCoinObservation,
  requiredConfirmations: number,
): boolean {
  if (!observation.backendOk || !observation.unspent || !observation.tx?.present) return false;
  return requiredConfirmations === 0 ||
    (observation.tx.confirmed &&
      observation.tx.confirmations >= requiredConfirmations);
}

function deriveSplitState(
  coin: PersistedCoin,
  knownShared: boolean,
  splitIntents: TransactionIntent[],
  confirmedSplit: boolean,
  settings: WalletSettings,
): SplitState {
  const { ecx, btc } = coin;
  if (!ecx.backendOk || !btc.backendOk || !ecx.tx || !btc.tx) return "unknown";
  const onEcx = ecx.tx.present && ecx.unspent === true;
  const onBtc = btc.tx.present && btc.unspent === true;
  if (!onEcx && !onBtc) return "spent";

  if (onEcx && !onBtc) {
    return observationIsSpendable(ecx, settings.ecxConfirmations) ? "ecx-only" : "confirming";
  }
  if (!onEcx && onBtc) {
    if (!observationIsSpendable(btc, settings.btcConfirmations)) return "confirming";
    if (!knownShared) return "btc-only";
    return confirmedSplit ? "split" : "split-pending";
  }

  if (
    !observationIsSpendable(ecx, settings.ecxConfirmations) ||
    !observationIsSpendable(btc, settings.btcConfirmations)
  ) {
    return "confirming";
  }
  return splitIntents.some((intent) => intent.phase !== "abandoned") ? "split-pending" : "unsplit";
}

export function deriveCoinPolicy(
  coin: PersistedCoin,
  knownShared: boolean,
  intents: TransactionIntent[],
  settings: WalletSettings,
): CoinPolicy {
  const related = intents.filter((intent) =>
    intent.kind === "ecx-replay"
      ? intent.walletInputOutpoints.includes(coin.outpoint) ||
        intent.walletOutpoints.includes(coin.outpoint)
      : intent.inputOutpoints.includes(coin.outpoint)
  );
  const splitIntents = related.filter((intent) =>
    intent.kind === "ecx-protected" && intent.sharedOutpoints.includes(coin.outpoint)
  );
  const blocking = related.filter((intent) => intentBlocksOutpoint(intent, coin.outpoint));
  const blockingOnEcx = blocking.filter((intent) =>
    intent.kind !== "btc-spend" || intent.replayRisk === undefined
  );
  const blockingSplits = blocking.filter((intent) =>
    intent.kind === "ecx-protected" && intent.sharedOutpoints.includes(coin.outpoint)
  );
  const protectedSpends = related.filter((intent) =>
    intent.kind === "ecx-protected" && intent.phase !== "abandoned"
  );
  const btcSpends = related.filter((intent) =>
    intent.kind === "btc-spend" && intent.phase !== "abandoned"
  );
  const replayIntents = related.filter((intent) =>
    intent.kind === "ecx-replay" && intent.phase !== "abandoned"
  );
  const replayInputReservedOnEcx = replayIntents.some((intent) =>
    intent.kind === "ecx-replay" && intent.walletInputOutpoints.includes(coin.outpoint)
  );
  const blockingBtc = blocking.some((intent) => intent.kind === "btc-spend");
  const blockingReplay = blocking.some((intent) => intent.kind === "ecx-replay");
  const confirmedSplitIntentIds = splitIntents
    .filter((intent) => splitProvidesConfirmedProtection(intent, intents))
    .map((intent) => intent.id)
    .sort();
  const confirmedSplit = confirmedSplitIntentIds.length > 0;

  const ecxSpendable = observationIsSpendable(coin.ecx, settings.ecxConfirmations);
  const btcSpendable = observationIsSpendable(coin.btc, settings.btcConfirmations);
  const onEcx = coin.ecx.backendOk && coin.ecx.unspent === true;
  const onBtc = coin.btc.backendOk && coin.btc.unspent === true;
  const splittable = onEcx && onBtc && ecxSpendable &&
    blockingOnEcx.length === 0 && protectedSpends.length === 0 && !replayInputReservedOnEcx;
  const ecxOnlySpendable = onEcx && coin.btc.backendOk && coin.btc.unspent === false &&
    ecxSpendable && blockingOnEcx.length === 0 && protectedSpends.length === 0 &&
    !replayInputReservedOnEcx;

  const pendingSplits = blockingSplits
    .filter((intent) => intent.phase === "seen" || intent.phase === "broadcast-unknown");
  const pendingSplitIntentIds = pendingSplits
    .map((intent) => intent.id)
    .sort();
  const pendingSplitSet = new Set(pendingSplitIntentIds);
  const incompatibleProtectedIntent = blocking.some((intent) =>
    intent.kind === "ecx-protected" && !pendingSplitSet.has(intent.id)
  );
  const ecxCopyAbsent = coin.ecx.backendOk && coin.ecx.unspent === false;
  const hasSplitIntent = splitIntents.some((intent) => intent.phase !== "abandoned");
  const replayCandidate = !knownShared && ecxCopyAbsent && btcSpendable &&
    blocking.length === 0 && !hasSplitIntent && replayIntents.length === 0;
  const replayRiskOverride = coin.ecx.backendOk && !confirmedSplit &&
    !incompatibleProtectedIntent && (knownShared || replayCandidate);
  const separated = ecxCopyAbsent && (!knownShared || confirmedSplit);
  const btcSelectable = btcSpendable && !blockingBtc && !blockingReplay &&
    btcSpends.length === 0 &&
    (separated || replayRiskOverride);
  const btcRisks: SpendRisk[] = replayRiskOverride
    ? [{
      kind: knownShared ? "shared-coin-replay" : "possible-funding-replay",
      splitIntentIds: pendingSplitIntentIds,
    }]
    : [];
  const btcReplayProtectionSplitIntentIds = knownShared && ecxCopyAbsent && confirmedSplit
    ? confirmedSplitIntentIds
    : [];
  return {
    output: {
      ...structuredClone(coin),
      wasShared: knownShared,
      splitState: deriveSplitState(coin, knownShared, splitIntents, confirmedSplit, settings),
    },
    ecxSelectable: splittable || ecxOnlySpendable,
    btcSelectable,
    splittable,
    replayCandidate,
    btcRisks,
    btcReplayProtectionSplitIntentIds,
  };
}

export function authorizeSpend(
  coins: PersistedCoin[],
  chain: ChainId,
  provenance: Record<string, unknown>,
  intents: TransactionIntent[],
  settings: WalletSettings,
): SpendAuthorization {
  const risks = new Map<string, Set<string>>();
  const replayProtectionSplitIntentIds = new Set<string>();
  const splitOutpoints: string[] = [];
  for (const coin of coins) {
    const policy = deriveCoinPolicy(coin, Boolean(provenance[coin.outpoint]), intents, settings);
    const allowed = chain === "btc" ? policy.btcSelectable : policy.ecxSelectable;
    if (!allowed) {
      if (chain === "btc" && policy.splittable) {
        throw new Error(`Output ${coin.outpoint} is shared; split it on ECX before BTC spend`);
      }
      throw new Error(
        `Output ${coin.outpoint} is ${policy.output.splitState}, not selectable for this action`,
      );
    }
    if (chain === "ecx" && policy.splittable) splitOutpoints.push(coin.outpoint);
    if (chain === "btc") {
      policy.btcReplayProtectionSplitIntentIds.forEach((intentId) =>
        replayProtectionSplitIntentIds.add(intentId)
      );
      for (const risk of policy.btcRisks) {
        const intentIds = risks.get(risk.kind) ?? new Set<string>();
        risk.splitIntentIds.forEach((intentId) => intentIds.add(intentId));
        risks.set(risk.kind, intentIds);
      }
    }
  }
  splitOutpoints.sort();
  return {
    splitInputCount: splitOutpoints.length,
    splitOutpoints,
    // Every signature commits to the complete input set. One confirmed split
    // input is therefore enough to make the whole standard BTC transaction
    // invalid on ECX, even if other selected coins remain shared.
    risks: replayProtectionSplitIntentIds.size > 0
      ? []
      : [...risks.entries()].map(([kind, intentIds]) => ({
        kind: kind as SpendRisk["kind"],
        splitIntentIds: [...intentIds].sort(),
      })),
    replayProtectionSplitIntentIds: [...replayProtectionSplitIntentIds].sort(),
  };
}
