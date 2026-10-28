import { failedObservation, utxoObservation } from "./chain_observations.ts";
import type { EsploraAddress, EsploraClient, EsploraUtxo } from "./esplora.ts";
import type { Bip86Keychain } from "./keys.ts";
import { intentNeedsReconciliation, intentOutpoints } from "./intent_state.ts";
import type { ChainId, PersistedCoin, WalletAddress, WalletPublicState } from "./types.ts";

const RECOVERY_ADDRESSES_PER_SYNC = 25;
export const MAX_DERIVATION_INDEX = 0x7fff_ffff;

export type WalletClients = { ecx: EsploraClient; btc: EsploraClient };

interface DiscoveredOutput {
  address: WalletAddress;
  ecx?: EsploraUtxo;
  btc?: EsploraUtxo;
}

export interface AddressScanResult {
  complete: boolean;
  /** True only when both chains were scanned completely. */
  authoritative: boolean;
  /** A successful chain can still be authoritative when the other backend fails. */
  authoritativeChains: Record<ChainId, boolean>;
  outputs: Map<string, DiscoveredOutput>;
}

const NO_AUTHORITATIVE_CHAINS: Record<ChainId, boolean> = {
  ecx: false,
  btc: false,
};

function hasActivity(info: EsploraAddress): boolean {
  return info.chain_stats.tx_count + info.mempool_stats.tx_count > 0;
}

export function settledErrorReason(result: PromiseSettledResult<unknown>): string {
  if (result.status === "fulfilled") return "unknown error";
  return result.reason instanceof Error ? result.reason.message : String(result.reason);
}

function addUtxos(
  outputs: Map<string, DiscoveredOutput>,
  address: WalletAddress,
  chain: ChainId,
  utxos: EsploraUtxo[],
  errors: string[],
): boolean {
  if (!Array.isArray(utxos)) {
    errors.push(`${chain.toUpperCase()} returned a malformed UTXO list`);
    return false;
  }
  for (const utxo of utxos) {
    if (
      !utxo || !/^[0-9a-f]{64}$/u.test(utxo.txid) ||
      !Number.isSafeInteger(utxo.vout) || utxo.vout < 0 ||
      !Number.isSafeInteger(utxo.value) || utxo.value < 0 ||
      typeof utxo.status?.confirmed !== "boolean"
    ) {
      errors.push(`${chain.toUpperCase()} returned a malformed UTXO`);
      return false;
    }
    if (utxo.value === 0) continue;
    const outpoint = `${utxo.txid}:${utxo.vout}`;
    const existing = outputs.get(outpoint);
    const other = existing?.ecx ?? existing?.btc;
    if (
      existing &&
      (existing.address.scriptPubKey !== address.scriptPubKey || other?.value !== utxo.value)
    ) {
      errors.push(`Backend mismatch for ${outpoint}`);
      return false;
    }
    const discovered = existing ?? { address };
    discovered[chain] = utxo;
    outputs.set(outpoint, discovered);
  }
  return true;
}

export async function scanRecoveryAddresses(
  state: WalletPublicState,
  keychain: Bip86Keychain | null,
  clients: WalletClients,
  errors: string[],
): Promise<AddressScanResult> {
  const savedProgress = state.recoveryScan;
  let index = savedProgress?.nextIndex ?? 0;
  let gap = savedProgress?.trailingGap ?? 0;
  let complete = false;
  const scanGap = state.settings.scanGap;
  const outputs = new Map<string, DiscoveredOutput>();
  let scanned = 0;
  while (index <= MAX_DERIVATION_INDEX && scanned < RECOVERY_ADDRESSES_PER_SYNC) {
    let address = state.addresses.find((candidate) =>
      candidate.branch === 0 && candidate.index === index
    );
    if (!address) {
      if (!keychain) break;
      address = keychain.derive(0, index);
      state.addresses.push(address);
    }
    const [ecxInfo, btcInfo] = await Promise.allSettled([
      clients.ecx.address(address.address),
      clients.btc.address(address.address),
    ]);
    if (ecxInfo.status === "rejected" || btcInfo.status === "rejected") {
      if (ecxInfo.status === "rejected") {
        errors.push(`ECX address ${index}: ${settledErrorReason(ecxInfo)}`);
      }
      if (btcInfo.status === "rejected") {
        errors.push(`BTC address ${index}: ${settledErrorReason(btcInfo)}`);
      }
      break;
    }
    const ecxUsed = hasActivity(ecxInfo.value);
    const btcUsed = hasActivity(btcInfo.value);
    address.used = ecxUsed || btcUsed;
    if (address.used) gap = 0;
    else gap++;

    const utxoResults = await Promise.allSettled([
      ecxUsed ? clients.ecx.addressUtxos(address.address) : Promise.resolve([]),
      btcUsed ? clients.btc.addressUtxos(address.address) : Promise.resolve([]),
    ]);
    if (utxoResults[0].status === "rejected" || utxoResults[1].status === "rejected") {
      if (utxoResults[0].status === "rejected") {
        errors.push(`ECX UTXOs ${index}: ${settledErrorReason(utxoResults[0])}`);
      }
      if (utxoResults[1].status === "rejected") {
        errors.push(`BTC UTXOs ${index}: ${settledErrorReason(utxoResults[1])}`);
      }
      break;
    }
    if (
      !addUtxos(outputs, address, "ecx", utxoResults[0].value, errors) ||
      !addUtxos(outputs, address, "btc", utxoResults[1].value, errors)
    ) {
      state.recoveryScan = { nextIndex: index, trailingGap: gap };
      return {
        complete: false,
        authoritative: false,
        authoritativeChains: { ...NO_AUTHORITATIVE_CHAINS },
        outputs,
      };
    }

    if (gap >= scanGap && index >= state.nextReceiveIndex - 1) {
      complete = true;
      break;
    }
    index++;
    scanned++;
  }
  if (complete) {
    // Keep a terminal resume point until the caller has rechecked all previously used addresses.
    state.recoveryScan = { nextIndex: index, trailingGap: Math.max(0, gap - 1) };
  } else {
    if (index > MAX_DERIVATION_INDEX) {
      errors.push("Address recovery reached the BIP32 derivation limit");
    }
    state.recoveryScan = { nextIndex: index, trailingGap: gap };
  }
  return {
    complete,
    authoritative: false,
    authoritativeChains: { ...NO_AUTHORITATIVE_CHAINS },
    outputs,
  };
}

export async function scanCurrentUtxos(
  state: WalletPublicState,
  clients: WalletClients,
  errors: string[],
  available: Record<ChainId, boolean> = { ecx: true, btc: true },
): Promise<AddressScanResult> {
  const outputs = new Map<string, DiscoveredOutput>();
  const authoritativeChains = { ...available };
  const addresses = state.addresses
    // Recovery derives a trailing unused lookahead window. Keep every one of those
    // addresses under observation so a delayed invoice remains discoverable.
    .filter((address) => address.branch === 0)
    .sort((left, right) => left.index - right.index);
  if (addresses.length === 0) {
    errors.push("No issued receive address is available");
    return {
      complete: false,
      authoritative: false,
      authoritativeChains: { ...NO_AUTHORITATIVE_CHAINS },
      outputs,
    };
  }
  for (const address of addresses) {
    const queried = { ...authoritativeChains };
    if (!queried.ecx && !queried.btc) break;
    const results = await Promise.allSettled([
      queried.ecx ? clients.ecx.addressUtxos(address.address) : Promise.resolve([]),
      queried.btc ? clients.btc.addressUtxos(address.address) : Promise.resolve([]),
    ]);

    for (const [index, chain] of (["ecx", "btc"] as const).entries()) {
      if (!queried[chain]) continue;
      const result = results[index];
      if (result.status === "rejected") {
        errors.push(
          `${chain.toUpperCase()} UTXOs ${address.index}: ${settledErrorReason(result)}`,
        );
        authoritativeChains[chain] = false;
        continue;
      }
      if (!addUtxos(outputs, address, chain, result.value, errors)) {
        authoritativeChains[chain] = false;
        continue;
      }
      address.used ||= result.value.length > 0;
    }
  }
  const authoritative = authoritativeChains.ecx && authoritativeChains.btc;
  return { complete: authoritative, authoritative, authoritativeChains, outputs };
}

export function installDiscoveredOutputs(
  state: WalletPublicState,
  scan: AddressScanResult,
  ecxTipHeight: number,
  btcTipHeight: number,
): void {
  const previous = new Map(state.coins.map((coin) => [coin.outpoint, coin]));
  const governed = new Set(
    state.intents
      .filter(intentNeedsReconciliation)
      .flatMap(intentOutpoints),
  );
  const current: PersistedCoin[] = [];
  for (const [outpoint, discovered] of scan.outputs) {
    const { address, ecx, btc } = discovered;
    const utxo = ecx ?? btc;
    if (!utxo) continue;
    const known = previous.get(outpoint);
    const unknown = failedObservation(new Error("Awaiting dual-chain observation"));
    if (
      known &&
      (known.value !== utxo.value || known.address !== address.address ||
        known.scriptPubKey !== address.scriptPubKey || known.path !== address.path)
    ) {
      throw new Error(`Backend identity changed for ${outpoint}`);
    }
    const coin: PersistedCoin = {
      ...(known ?? {
        outpoint,
        txid: utxo.txid,
        vout: utxo.vout,
        ecx: structuredClone(unknown),
        btc: structuredClone(unknown),
      }),
      txid: utxo.txid,
      vout: utxo.vout,
      value: utxo.value,
      address: address.address,
      scriptPubKey: address.scriptPubKey,
      path: address.path,
      ecx: ecx
        ? utxoObservation(ecx, ecxTipHeight)
        : !scan.authoritativeChains.ecx
        ? structuredClone(known?.ecx ?? unknown)
        : utxoObservation(undefined, ecxTipHeight),
      btc: btc
        ? utxoObservation(btc, btcTipHeight)
        : !scan.authoritativeChains.btc
        ? structuredClone(known?.btc ?? unknown)
        : utxoObservation(undefined, btcTipHeight),
    };
    const previouslySeenOnEcx = known?.ecx.backendOk === true &&
      known.ecx.tx?.present === true;
    const previouslySeenOnBtc = known?.btc.backendOk === true && known.btc.tx?.present === true;
    if ((Boolean(ecx) || previouslySeenOnEcx) && (Boolean(btc) || previouslySeenOnBtc)) {
      state.sharedProvenance[outpoint] ??= {
        firstObservedAt: new Date().toISOString(),
      };
    }
    current.push(coin);
    previous.delete(outpoint);
  }
  for (const coin of previous.values()) {
    const refreshed: PersistedCoin = {
      ...coin,
      ecx: scan.authoritativeChains.ecx ? utxoObservation(undefined, ecxTipHeight) : coin.ecx,
      btc: scan.authoritativeChains.btc ? utxoObservation(undefined, btcTipHeight) : coin.btc,
    };
    const fullyAbsent = scan.authoritative && refreshed.ecx.unspent === false &&
      refreshed.btc.unspent === false;
    if (
      fullyAbsent && !state.sharedProvenance[coin.outpoint] && !governed.has(coin.outpoint)
    ) continue;
    // Failed chains retain their cached observation; successful chains can still record
    // absence independently. Provenance and intent history remain monotonic safety facts.
    current.push(refreshed);
  }
  state.coins = current.sort((left, right) => left.outpoint.localeCompare(right.outpoint));
}

export function advanceReceiveAddressPastUsed(
  state: WalletPublicState,
  keychain: Bip86Keychain | null,
): void {
  if (!keychain) return;
  const highestUsed = state.addresses.reduce(
    (highest, address) =>
      address.branch === 0 && address.used ? Math.max(highest, address.index) : highest,
    -1,
  );
  if (highestUsed < state.nextReceiveIndex - 1) return;
  const freshIndex = highestUsed + 1;
  if (!state.addresses.some((address) => address.branch === 0 && address.index === freshIndex)) {
    state.addresses.push(keychain.derive(0, freshIndex));
  }
  state.nextReceiveIndex = freshIndex + 1;
}

function nextUnusedReceiveAddressIndex(state: WalletPublicState): number {
  let index = state.nextReceiveIndex;
  while (
    index < MAX_DERIVATION_INDEX &&
    state.addresses.some((address) =>
      address.branch === 0 && address.index === index && address.used
    )
  ) index++;
  return index;
}

export function canIssueNextReceiveAddress(state: WalletPublicState): boolean {
  const index = nextUnusedReceiveAddressIndex(state);
  if (index >= MAX_DERIVATION_INDEX) return false;
  const highestUsedBefore = state.addresses.reduce(
    (highest, address) =>
      address.branch === 0 && address.used && address.index < index
        ? Math.max(highest, address.index)
        : highest,
    -1,
  );
  return index - highestUsedBefore <= state.settings.scanGap;
}

/** Issue the first cached or newly derived receive address that has no known history. */
export function issueNextUnusedReceiveAddress(
  state: WalletPublicState,
  keychain: Bip86Keychain,
): void {
  const index = nextUnusedReceiveAddressIndex(state);
  if (index >= MAX_DERIVATION_INDEX) {
    throw new Error("Wallet reached the BIP32 receive-address limit");
  }
  if (!state.addresses.some((address) => address.branch === 0 && address.index === index)) {
    state.addresses.push(keychain.derive(0, index));
  }
  state.nextReceiveIndex = index + 1;
}

export function advanceReceiveAddressAfterConfirmedDeposit(
  state: WalletPublicState,
  keychain: Bip86Keychain | null,
): void {
  if (!keychain || state.nextReceiveIndex === 0) return;
  const currentIndex = state.nextReceiveIndex - 1;
  const current = state.addresses.find((address) =>
    address.branch === 0 && address.index === currentIndex
  );
  if (!current) return;
  const confirmedDeposit = state.coins.some((coin) =>
    coin.address === current.address &&
    [coin.btc, coin.ecx].some((observation) =>
      observation.backendOk && observation.unspent === true &&
      observation.tx?.present === true && observation.tx.confirmed
    )
  ) || state.intents.some((intent) =>
    intent.kind !== "ecx-replay" && intent.phase === "confirmed" &&
    intent.inputOutpoints.some((outpoint) =>
      state.coins.some((coin) =>
        coin.outpoint === outpoint && coin.address === current.address
      )
    )
  );
  if (!confirmedDeposit) return;
  issueNextUnusedReceiveAddress(state, keychain);
}

function validatedUtxoMap(chain: ChainId, utxos: EsploraUtxo[]): Map<string, EsploraUtxo> {
  if (!Array.isArray(utxos)) {
    throw new Error(`${chain.toUpperCase()} returned a malformed UTXO list`);
  }
  const result = new Map<string, EsploraUtxo>();
  for (const utxo of utxos) {
    if (
      !utxo || !/^[0-9a-f]{64}$/u.test(utxo.txid) ||
      !Number.isSafeInteger(utxo.vout) || utxo.vout < 0 || utxo.vout > 0xffff_ffff ||
      !Number.isSafeInteger(utxo.value) || utxo.value < 0 ||
      typeof utxo.status?.confirmed !== "boolean" ||
      (utxo.status.confirmed &&
        (!Number.isSafeInteger(utxo.status.block_height) ||
          (utxo.status.block_height as number) < 0))
    ) {
      throw new Error(`${chain.toUpperCase()} returned a malformed UTXO`);
    }
    if (utxo.value === 0) continue;
    const outpoint = `${utxo.txid}:${utxo.vout}`;
    if (result.has(outpoint)) {
      throw new Error(`${chain.toUpperCase()} returned a duplicate UTXO`);
    }
    result.set(outpoint, utxo);
  }
  return result;
}

export async function refreshSelectedUtxos(
  state: WalletPublicState,
  outputs: PersistedCoin[],
  clients: WalletClients,
  ecxTipHeight: number,
  btcTipHeight: number,
): Promise<void> {
  const byAddress = new Map<string, PersistedCoin[]>();
  for (const output of outputs) {
    const group = byAddress.get(output.address) ?? [];
    group.push(output);
    byAddress.set(output.address, group);
  }
  for (const [address, group] of byAddress) {
    const [ecxUtxos, btcUtxos] = await Promise.all([
      clients.ecx.addressUtxos(address),
      clients.btc.addressUtxos(address),
    ]);
    const ecxByOutpoint = validatedUtxoMap("ecx", ecxUtxos);
    const btcByOutpoint = validatedUtxoMap("btc", btcUtxos);
    for (const output of group) {
      const ecx = ecxByOutpoint.get(output.outpoint);
      const btc = btcByOutpoint.get(output.outpoint);
      if ((ecx && ecx.value !== output.value) || (btc && btc.value !== output.value)) {
        throw new Error(`Backend value changed for ${output.outpoint}`);
      }
      output.ecx = utxoObservation(ecx, ecxTipHeight);
      output.btc = utxoObservation(btc, btcTipHeight);
      if (ecx && btc) {
        state.sharedProvenance[output.outpoint] ??= {
          firstObservedAt: new Date().toISOString(),
        };
      }
    }
  }
}

export async function refreshFundingProvenance(
  state: WalletPublicState,
  coins: PersistedCoin[],
  ecx: EsploraClient,
): Promise<void> {
  const unknownByTxid = new Map<string, PersistedCoin[]>();
  for (const coin of coins) {
    if (state.sharedProvenance[coin.outpoint]) continue;
    const group = unknownByTxid.get(coin.txid) ?? [];
    group.push(coin);
    unknownByTxid.set(coin.txid, group);
  }
  const statuses = await Promise.all(
    [...unknownByTxid].map(async ([txid, outputs]) => ({
      outputs,
      status: await ecx.transactionStatus(txid),
    })),
  );
  const observedAt = new Date().toISOString();
  for (const { outputs, status } of statuses) {
    if (!status) continue;
    for (const output of outputs) {
      state.sharedProvenance[output.outpoint] ??= { firstObservedAt: observedAt };
    }
  }
}
