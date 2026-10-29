import { MAINNET_API_URL, MAINNET_FORK_CHECKPOINT } from "./network.ts";
import type { ForkCheckpoint } from "./chain_verifier.ts";
export type ChainId = "ecx" | "btc";
export type AmountUnit = "sat" | "btc" | "bip177";
export type WalletLockState = "empty" | "locked" | "unlocked";
export type SplitState =
  | "confirming"
  | "unsplit"
  | "ecx-only"
  | "btc-only"
  | "split-pending"
  | "split"
  | "spent"
  | "unknown";

export interface WalletSettings {
  forkCheckpoint?: ForkCheckpoint;
  btcApiUrl: string;
  ecxApiUrl: string;
  amountUnit: AmountUnit;
  btcConfirmations: number;
  ecxConfirmations: number;
  scanGap: number;
  btcFeeRate?: number;
  ecxFeeRate?: number;
}

export type WalletSettingsUpdate =
  & Omit<
    Partial<WalletSettings>,
    "btcFeeRate" | "ecxFeeRate"
  >
  & {
    btcFeeRate?: number | null;
    ecxFeeRate?: number | null;
  };

export interface WalletAddress {
  address: string;
  scriptPubKey: string;
  path: string;
  branch: 0 | 1;
  index: number;
  used: boolean;
}

export interface ChainTip {
  height: number;
  fetchedAt: string;
}

export interface ChainTxStatus {
  present: boolean;
  confirmed: boolean;
  blockHeight?: number;
  blockHash?: string;
  confirmations: number;
}

export interface ChainCoinObservation {
  checkedAt: string;
  backendOk: boolean;
  tx: ChainTxStatus | null;
  unspent: boolean | null;
  error?: string;
}

export interface TrackedOutput {
  outpoint: string;
  txid: string;
  vout: number;
  value: number;
  address: string;
  scriptPubKey: string;
  path: string;
  ecx: ChainCoinObservation;
  btc: ChainCoinObservation;
  splitState: SplitState;
  /** Derived from the authoritative provenance map; never persisted in the coin cache. */
  wasShared: boolean;
}

export interface PersistedCoin {
  outpoint: string;
  txid: string;
  vout: number;
  value: number;
  address: string;
  scriptPubKey: string;
  path: string;
  ecx: ChainCoinObservation;
  btc: ChainCoinObservation;
}

export interface SharedProvenance {
  firstObservedAt: string;
}

export type IntentPhase =
  | "prepared"
  | "broadcast-unknown"
  | "seen"
  | "confirmed"
  | "recoverable"
  | "abandoned";

export interface IntentObservation {
  checkedAt: string;
  backendOk: boolean;
  tx: ChainTxStatus | null;
  error?: string;
}

interface TransactionIntentBase {
  id: string;
  txid: string;
  rawTx: string;
  createdAt: string;
  phase: IntentPhase;
  broadcastStartedAt?: string;
  lastBroadcastAt?: string;
  lastObservation?: IntentObservation;
  lastError?: string;
  abandonedAt?: string;
}

export type TransactionIntent =
  | TransactionIntentBase & {
    /** Every locally signed nLockTime = 499999999 spend, including pure ECX-only sends. */
    kind: "ecx-protected";
    chain: "ecx";
    inputOutpoints: string[];
    /** The exact subset that was present and unspent on both chains when signed. */
    sharedOutpoints: string[];
    parentReplayIntentIds: string[];
  }
  | TransactionIntentBase & {
    kind: "btc-spend";
    chain: "btc";
    inputOutpoints: string[];
    replayRisk?: {
      kinds: SpendRisk["kind"][];
      splitIntentIds: string[];
      acknowledgedAt: string;
    };
    /** Confirmed ECX splits whose spent inputs made this complete BTC transaction unreplayable. */
    replayProtection?: {
      splitIntentIds: string[];
    };
  }
  | TransactionIntentBase & {
    kind: "ecx-replay";
    chain: "ecx";
    /** Known wallet inputs consumed when the original BTC transaction is replayed on ECX. */
    walletInputOutpoints: string[];
    /** Wallet outputs recreated by the replayed transaction. */
    walletOutpoints: string[];
  };

export interface IntentSummary {
  id: string;
  txid: string;
  kind: TransactionIntent["kind"];
  action: "send" | "split" | "replay";
  chain: ChainId;
  phase: IntentPhase;
  outpoints: string[];
  createdAt: string;
  lastError?: string;
  blockedBy: string[];
  canRebroadcast: boolean;
  canAbandon: boolean;
}

export interface RecoveryScanProgress {
  nextIndex: number;
  trailingGap: number;
}

export interface WalletPublicState {
  schema: 1;
  createdAt?: string;
  recoveryPhraseAcknowledged: boolean;
  recoveryScanComplete: boolean;
  recoveryScan?: RecoveryScanProgress;
  nextReceiveIndex: number;
  addresses: WalletAddress[];
  coins: PersistedCoin[];
  /** Monotonic safety facts, independent of the discardable coin cache. */
  sharedProvenance: Record<string, SharedProvenance>;
  intents: TransactionIntent[];
  tips: Partial<Record<ChainId, ChainTip>>;
  settings: WalletSettings;
  lastSyncAt?: string;
  lastSyncError?: string;
}

export interface WalletSnapshot
  extends Omit<WalletPublicState, "coins" | "sharedProvenance" | "intents"> {
  lockState: WalletLockState;
  receiveAddress?: WalletAddress;
  canCreateReceiveAddress: boolean;
  outputs: TrackedOutput[];
  intents: IntentSummary[];
  balances: {
    ecx: number;
    btc: number;
    spendableEcx: number;
    spendableBtc: number;
    shared: number;
  };
  selectableEcxOutpoints: string[];
  selectableBtcOutpoints: string[];
  splittableOutpoints: string[];
  replayCandidateTxids: string[];
  warnings: string[];
}

export interface CreateWalletRequest {
  password: string;
}

export interface RestoreWalletRequest extends CreateWalletRequest {
  mnemonic: string;
}

export type SpendPurpose = "send" | "split";

export interface SpendPreviewRequest {
  chain: ChainId;
  purpose: SpendPurpose;
  outpoints: string[];
  destination: string;
  feeRate?: number;
}

export interface SpendPreview {
  id: string;
  createdAt: string;
  expiresAt: string;
  chain: ChainId;
  purpose: SpendPurpose;
  splitInputCount: number;
  splitOutpoints: string[];
  outpoints: string[];
  destination: string;
  inputValue: number;
  outputValue: number;
  fee: number;
  feeRate: number;
  vsize: number;
  lockTime: number;
  sighashType: number;
  highFee: boolean;
  risks: SpendRisk[];
  replayProtectionSplitIntentIds: string[];
}

export type SpendRisk = {
  kind: "shared-coin-replay" | "possible-funding-replay";
  /** Related locally pending splits; empty when no split has been initiated. */
  splitIntentIds: string[];
};

export interface ReplayPreview {
  id: string;
  createdAt: string;
  expiresAt: string;
  txid: string;
  walletOutpoints: string[];
  walletValue: number;
  inputCount: number;
  outputCount: number;
  totalOutputValue: number;
  version: number;
  lockTime: number;
}

export interface BroadcastResult {
  txid: string;
  rawTx: string;
  chain: ChainId;
  action: "send" | "split" | "replay";
}

export const DEFAULT_SETTINGS: WalletSettings = {
  btcApiUrl: "https://mempool.space/api",
  ecxApiUrl: MAINNET_API_URL,
  forkCheckpoint: MAINNET_FORK_CHECKPOINT,
  amountUnit: "btc",
  btcConfirmations: 1,
  ecxConfirmations: 1,
  scanGap: 10,
};

export function emptyPublicState(): WalletPublicState {
  return {
    schema: 1,
    recoveryPhraseAcknowledged: false,
    recoveryScanComplete: false,
    nextReceiveIndex: 0,
    addresses: [],
    coins: [],
    sharedProvenance: {},
    intents: [],
    tips: {},
    settings: structuredClone(DEFAULT_SETTINGS),
  };
}
