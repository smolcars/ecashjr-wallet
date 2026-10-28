import { failedIntentObservation, intentObservation } from "./chain_observations.ts";
import type { EsploraClient, EsploraTxStatus } from "./esplora.ts";
import { intentNeedsReconciliation, intentOutpoints, reduceIntent } from "./intent_state.ts";
import type { ChainId, TransactionIntent, WalletPublicState } from "./types.ts";
import type { WalletClients } from "./wallet_sync.ts";

export function linkReplayDependencies(
  state: WalletPublicState,
  replay: Extract<TransactionIntent, { kind: "ecx-replay" }>,
): void {
  const replayedOutpoints = new Set(replay.walletOutpoints);
  const abandonedEquivalentParentIds = new Set(
    state.intents
      .filter((candidate) =>
        candidate.id !== replay.id && candidate.kind === "ecx-replay" &&
        candidate.phase === "abandoned" && candidate.txid === replay.txid
      )
      .map((candidate) => candidate.id),
  );
  for (const candidate of state.intents) {
    if (
      candidate.kind !== "ecx-protected" || !intentNeedsReconciliation(candidate) ||
      !candidate.inputOutpoints.some((outpoint) => replayedOutpoints.has(outpoint))
    ) continue;
    candidate.parentReplayIntentIds = candidate.parentReplayIntentIds.filter((id) =>
      !abandonedEquivalentParentIds.has(id)
    );
    if (!candidate.parentReplayIntentIds.includes(replay.id)) {
      candidate.parentReplayIntentIds.push(replay.id);
      candidate.parentReplayIntentIds.sort();
    }
  }
}

function intentOwnsStatusObservation(
  intent: TransactionIntent,
  allIntents: TransactionIntent[],
): boolean {
  if (!intentNeedsReconciliation(intent)) return false;
  if (intent.phase !== "abandoned") return true;
  const equivalent = allIntents.filter((candidate) =>
    candidate.chain === intent.chain && candidate.kind === intent.kind &&
    candidate.txid === intent.txid
  );
  if (equivalent.some((candidate) => candidate.phase !== "abandoned")) return false;
  const newestExposed = equivalent
    .filter(intentNeedsReconciliation)
    .sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
    )
    .at(-1);
  return newestExposed?.id === intent.id;
}

function intentsCompeteForInput(left: TransactionIntent, right: TransactionIntent): boolean {
  if (left.id === right.id || left.chain !== right.chain) return false;
  const leftInputs = new Set(
    left.kind === "ecx-replay" ? left.walletInputOutpoints : left.inputOutpoints,
  );
  const rightInputs = right.kind === "ecx-replay"
    ? right.walletInputOutpoints
    : right.inputOutpoints;
  return rightInputs.some((outpoint) => leftInputs.has(outpoint));
}

/** Applies backend observations to the persisted transaction-intent state machines. */
export class IntentReconciler {
  constructor(private readonly state: () => WalletPublicState) {}

  reapplyConfirmationTargets(): void {
    const state = this.state();
    state.intents = state.intents.map((intent) => {
      const observation = intent.lastObservation;
      if (
        (intent.phase !== "seen" && intent.phase !== "confirmed") ||
        !observation?.backendOk || !observation.tx?.present
      ) return intent;
      return reduceIntent(intent, {
        type: "observed",
        observation,
        recoverable: false,
        requiredConfirmations: state.settings[`${intent.chain}Confirmations`],
      });
    });
  }

  async refreshStatuses(
    clients: WalletClients,
    tipHeights: Partial<Record<ChainId, number>>,
    errors: string[],
    relevantOutpoints?: Set<string>,
  ): Promise<void> {
    const state = this.state();
    const relevantIntentIds = relevantOutpoints
      ? dependencyClosure(state.intents, relevantOutpoints)
      : undefined;
    const intents = state.intents
      .filter((intent) => intentOwnsStatusObservation(intent, state.intents))
      .sort((left, right) =>
        Number(left.phase === "abandoned") - Number(right.phase === "abandoned") ||
        Number(right.kind === "ecx-replay") - Number(left.kind === "ecx-replay")
      );
    const refreshedIntentIds = new Set<string>();
    for (const intent of intents) {
      if (relevantIntentIds && !relevantIntentIds.has(intent.id)) continue;
      const tipHeight = tipHeights[intent.chain];
      if (tipHeight === undefined) continue;
      try {
        await this.refreshOne(
          intent.id,
          clients[intent.chain],
          tipHeight,
          refreshedIntentIds,
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const currentState = this.state();
        const current = currentState.intents.find((candidate) => candidate.id === intent.id);
        if (current) {
          const index = currentState.intents.indexOf(current);
          currentState.intents[index] = reduceIntent(current, {
            type: "observed",
            observation: failedIntentObservation(error),
            recoverable: false,
            requiredConfirmations: currentState.settings[`${current.chain}Confirmations`],
          });
        }
        errors.push(`${intentLabel(intent)} ${intent.txid.slice(0, 12)}: ${detail}`);
      } finally {
        refreshedIntentIds.add(intent.id);
      }
    }
  }

  async refreshOne(
    intentId: string,
    client: EsploraClient,
    tipHeight: number,
    refreshedIntentIds?: Set<string>,
  ): Promise<EsploraTxStatus | null> {
    const state = this.state();
    const intent = findIntent(state, intentId);
    const status = await client.transactionStatus(intent.txid, intent.rawTx);
    const observation = intentObservation(status, tipHeight);
    if (status && intent.phase === "abandoned" && refreshedIntentIds) {
      const competitors = state.intents.filter((candidate) =>
        candidate.phase !== "abandoned" && intentsCompeteForInput(intent, candidate)
      );
      for (const competitor of competitors) {
        if (!refreshedIntentIds.has(competitor.id)) {
          throw new Error("A competing transaction could not be checked before revival");
        }
        if (!competitor.lastObservation?.backendOk) {
          throw new Error("A competing transaction's status could not be verified");
        }
        if (competitor.lastObservation.tx?.present) {
          throw new Error("Backend reported conflicting transactions as simultaneously present");
        }
      }
      for (const competitor of competitors) {
        const competitorIndex = state.intents.findIndex((candidate) =>
          candidate.id === competitor.id
        );
        state.intents[competitorIndex] = reduceIntent(competitor, {
          type: "superseded",
          at: observation.checkedAt,
        });
      }
    }
    const index = state.intents.findIndex((candidate) => candidate.id === intentId);
    state.intents[index] = reduceIntent(intent, {
      type: "observed",
      observation,
      recoverable: intentInputsAreRecoverable(state, intent),
      requiredConfirmations: state.settings[`${intent.chain}Confirmations`],
    });
    const refreshed = state.intents[index];
    if (refreshed.kind === "ecx-replay" && status) {
      for (const outpoint of refreshed.walletInputOutpoints) {
        const coin = state.coins.find((candidate) => candidate.outpoint === outpoint);
        if (!coin) continue;
        coin.ecx = {
          checkedAt: observation.checkedAt,
          backendOk: true,
          tx: coin.ecx.tx?.present
            ? coin.ecx.tx
            : { present: true, confirmed: false, confirmations: 0 },
          unspent: false,
        };
      }
      for (const outpoint of refreshed.walletOutpoints) {
        state.sharedProvenance[outpoint] ??= {
          firstObservedAt: observation.checkedAt,
        };
      }
      linkReplayDependencies(state, refreshed);
    }
    return status;
  }
}

function dependencyClosure(
  intents: TransactionIntent[],
  relevantOutpoints: Set<string>,
): Set<string> {
  const relevant = new Set(
    intents
      .filter((intent) =>
        intentOutpoints(intent).some((outpoint) => relevantOutpoints.has(outpoint))
      )
      .map((intent) => intent.id),
  );
  const pending = intents.filter((intent) => relevant.has(intent.id));
  while (pending.length > 0) {
    const intent = pending.pop();
    const parents = intent?.kind === "ecx-protected" ? intent.parentReplayIntentIds : [];
    for (const parentId of parents) {
      if (relevant.has(parentId)) continue;
      const parent = intents.find((candidate) => candidate.id === parentId);
      if (!parent) continue;
      relevant.add(parentId);
      pending.push(parent);
    }
  }
  return relevant;
}

function findIntent(state: WalletPublicState, intentId: string): TransactionIntent {
  const intent = state.intents.find((candidate) => candidate.id === intentId);
  if (!intent) throw new Error(`Transaction intent ${intentId} is missing`);
  return intent;
}

function intentInputsAreRecoverable(
  state: WalletPublicState,
  intent: TransactionIntent,
): boolean {
  const coins = new Map(state.coins.map((coin) => [coin.outpoint, coin]));
  if (intent.kind === "ecx-replay") {
    return intent.walletInputOutpoints.every((outpoint) => {
      const coin = coins.get(outpoint);
      return coin?.ecx.backendOk === true && coin.ecx.unspent === true;
    });
  }
  if (intent.kind === "btc-spend") {
    return intent.inputOutpoints.every((outpoint) => {
      const coin = coins.get(outpoint);
      return coin?.btc.backendOk === true && coin.btc.unspent === true;
    });
  }
  const shared = new Set(intent.sharedOutpoints);
  return intent.inputOutpoints.every((outpoint) => {
    const coin = coins.get(outpoint);
    if (coin?.ecx.backendOk !== true || coin.ecx.unspent !== true) return false;
    return !shared.has(outpoint) ||
      (coin.btc.backendOk === true && coin.btc.unspent === true);
  });
}

function intentLabel(intent: TransactionIntent): string {
  if (intent.kind === "ecx-replay") return "ECX replay";
  if (intent.kind === "btc-spend") return "BTC spend";
  return intent.sharedOutpoints.length > 0 ? "ECX split" : "ECX spend";
}
