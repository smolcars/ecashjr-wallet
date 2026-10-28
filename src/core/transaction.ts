import { schnorr } from "@noble/curves/secp256k1.js";
import { SigHash, Transaction } from "@scure/btc-signer";
import {
  compactSize,
  concatBytes,
  equalBytes,
  fromHex,
  i64le,
  reverseBytes,
  u32le,
  varBytes,
} from "./bytes.ts";
import { parseDestinationAddress } from "./destination.ts";
import { Bip86Keychain } from "./keys.ts";
export interface SweepTransaction {
  version: number;
  lockTime: number;
  inputs: { txid: Uint8Array; index: number; sequence: number }[];
  outputs: { amount: bigint; script: Uint8Array }[];
}

export const ECX_REPLAY_LOCKTIME = 499_999_999;

/** Require the marker and a non-final input, including on restored/rebroadcast transactions. */
export function assertEcxReplayProtection(tx: Transaction): void {
  if (
    tx.lockTime !== ECX_REPLAY_LOCKTIME || tx.inputsLength === 0 ||
    !Array.from({ length: tx.inputsLength }, (_, i) => tx.getInput(i).sequence)
      .some((sequence) => sequence !== undefined && sequence < 0xffff_ffff)
  ) {
    throw new Error("ECX transaction is missing nLockTime replay protection");
  }
}

export const RBF_SEQUENCE = 0xffff_fffd;
export const MAX_FEE_RATE = 100;
export const HIGH_FEE_RATE = 50;

export function feeNeedsExplicitConfirmation(
  inputValue: number,
  fee: number,
  feeRate: number,
): boolean {
  return feeRate >= HIGH_FEE_RATE || fee * 10 >= inputValue;
}

export interface SpendableCoin {
  txid: string;
  vout: number;
  value: number;
  scriptPubKey: string;
  path: string;
}

export type SweepMode = "ecx-protected" | "btc-standard";

export interface SweepTemplate {
  mode: SweepMode;
  coins: SpendableCoin[];
  destination: string;
  destinationScript: Uint8Array;
  feeRate: number;
  fee: number;
  inputValue: number;
  outputValue: number;
  vsize: number;
  lockTime: number;
  tx: SweepTransaction;
}

export interface SignedSweep {
  rawTx: string;
  txid: string;
  vsize: number;
  fee: number;
  outputValue: number;
}

function validateCoin(coin: SpendableCoin): void {
  if (!/^[0-9a-f]{64}$/u.test(coin.txid)) throw new Error(`Invalid transaction id: ${coin.txid}`);
  if (!Number.isSafeInteger(coin.vout) || coin.vout < 0 || coin.vout > 0xffff_ffff) {
    throw new Error("Invalid output index");
  }
  if (!Number.isSafeInteger(coin.value) || coin.value <= 0) throw new Error("Invalid coin value");
  const script = fromHex(coin.scriptPubKey);
  if (script.length !== 34 || script[0] !== 0x51 || script[1] !== 0x20) {
    throw new Error("Selected coin is not a Taproot output");
  }
}

function sortedCoins(coins: SpendableCoin[]): SpendableCoin[] {
  return [...coins].sort((left, right) =>
    left.txid.localeCompare(right.txid) || left.vout - right.vout
  );
}

export function serializeStripped(tx: SweepTransaction): Uint8Array {
  return concatBytes(
    u32le(tx.version >>> 0),
    compactSize(tx.inputs.length),
    ...tx.inputs.map((input) =>
      concatBytes(
        reverseBytes(input.txid),
        u32le(input.index),
        Uint8Array.of(0),
        u32le(input.sequence),
      )
    ),
    compactSize(tx.outputs.length),
    ...tx.outputs.map((output) => concatBytes(i64le(output.amount), varBytes(output.script))),
    u32le(tx.lockTime),
  );
}

function serializeWithWitness(tx: SweepTransaction, witnesses: Uint8Array[]): Uint8Array {
  if (witnesses.length !== tx.inputs.length) throw new Error("Witness count does not match inputs");
  const strippedParts = [
    compactSize(tx.inputs.length),
    ...tx.inputs.map((input) =>
      concatBytes(
        reverseBytes(input.txid),
        u32le(input.index),
        Uint8Array.of(0),
        u32le(input.sequence),
      )
    ),
    compactSize(tx.outputs.length),
    ...tx.outputs.map((output) => concatBytes(i64le(output.amount), varBytes(output.script))),
  ];
  return concatBytes(
    u32le(tx.version >>> 0),
    Uint8Array.of(0, 1),
    ...strippedParts,
    ...witnesses.map((witness) => concatBytes(Uint8Array.of(1), varBytes(witness))),
    u32le(tx.lockTime),
  );
}

function virtualSize(tx: SweepTransaction, witnessSize: number): number {
  const strippedSize = serializeStripped(tx).length;
  const fullSize = serializeWithWitness(
    tx,
    tx.inputs.map(() => new Uint8Array(witnessSize)),
  ).length;
  return Math.ceil((strippedSize * 4 + fullSize - strippedSize) / 4);
}

export function createSweepTemplate(
  requestedCoins: SpendableCoin[],
  destination: string,
  feeRate: number,
  lockTime: number,
  mode: SweepMode = "ecx-protected",
): SweepTemplate {
  if (requestedCoins.length === 0) throw new Error("Select at least one output");
  if (!Number.isFinite(feeRate) || feeRate <= 0 || feeRate > MAX_FEE_RATE) {
    throw new Error(`Fee rate must be between 0 and ${MAX_FEE_RATE} sat/vB`);
  }
  if (!Number.isSafeInteger(lockTime) || lockTime < 0 || lockTime > 0xffff_ffff) {
    throw new Error("Invalid locktime");
  }
  requestedCoins.forEach(validateCoin);
  const coins = sortedCoins(requestedCoins);
  const duplicate = coins.find((coin, index) =>
    index > 0 && coin.txid === coins[index - 1].txid && coin.vout === coins[index - 1].vout
  );
  if (duplicate) throw new Error(`Duplicate input ${duplicate.txid}:${duplicate.vout}`);

  const parsedDestination = parseDestinationAddress(destination);
  const script = parsedDestination.script;
  const inputValue = coins.reduce((total, coin) => total + coin.value, 0);
  if (mode === "ecx-protected") lockTime = ECX_REPLAY_LOCKTIME;
  const provisional: SweepTransaction = {
    version: 2,
    lockTime,
    inputs: coins.map((coin) => ({
      txid: fromHex(coin.txid),
      index: coin.vout,
      sequence: RBF_SEQUENCE,
    })),
    outputs: [{ amount: BigInt(inputValue), script }],
  };
  if (mode !== "ecx-protected" && mode !== "btc-standard") {
    throw new Error("Unsupported sweep mode");
  }
  const vsize = virtualSize(provisional, 64);
  const fee = Math.ceil(vsize * feeRate);
  const outputValue = inputValue - fee;
  if (outputValue < parsedDestination.dustLimit) {
    throw new Error(
      `Sweep output would be below the ${parsedDestination.dustLimit}-sat dust limit for this destination`,
    );
  }
  provisional.outputs[0].amount = BigInt(outputValue);
  return {
    mode,
    coins,
    destination: parsedDestination.address,
    destinationScript: script,
    feeRate,
    fee,
    inputValue,
    outputValue,
    vsize,
    lockTime,
    tx: provisional,
  };
}

export function signEcxSweep(template: SweepTemplate, keychain: Bip86Keychain): SignedSweep {
  if (
    template.mode !== "ecx-protected" || template.lockTime !== ECX_REPLAY_LOCKTIME ||
    template.tx.lockTime !== ECX_REPLAY_LOCKTIME ||
    template.tx.inputs.some((input) => input.sequence !== RBF_SEQUENCE)
  ) {
    throw new Error("Expected an ECX replay-protected sweep");
  }
  const signed = signStandardSweep(template, keychain);
  assertEcxReplayProtection(Transaction.fromRaw(fromHex(signed.rawTx)));
  return signed;
}

export const signSweep = signEcxSweep;

export function signBtcSweep(template: SweepTemplate, keychain: Bip86Keychain): SignedSweep {
  if (template.mode !== "btc-standard") throw new Error("Expected a standard BTC sweep");
  return signStandardSweep(template, keychain);
}

function signStandardSweep(template: SweepTemplate, keychain: Bip86Keychain): SignedSweep {
  const tx = new Transaction({ version: template.tx.version, lockTime: template.tx.lockTime });
  const prevOutScripts = template.coins.map((coin) => fromHex(coin.scriptPubKey));
  const amounts = template.coins.map((coin) => BigInt(coin.value));

  for (const coin of template.coins) {
    const expectedPublicKey = fromHex(coin.scriptPubKey).slice(2);
    const derivedPublicKey = keychain.outputPublicKey(coin.path);
    if (!equalBytes(expectedPublicKey, derivedPublicKey)) {
      throw new Error(`Derivation path does not control input ${coin.txid}:${coin.vout}`);
    }
    tx.addInput({
      txid: coin.txid,
      index: coin.vout,
      sequence: RBF_SEQUENCE,
      witnessUtxo: {
        amount: BigInt(coin.value),
        script: fromHex(coin.scriptPubKey),
      },
      tapInternalKey: keychain.internalPublicKey(coin.path),
    });
  }
  tx.addOutput({ script: template.destinationScript, amount: BigInt(template.outputValue) });

  for (let index = 0; index < template.coins.length; index++) {
    const coin = template.coins[index];
    const privateKey = keychain.privateKey(coin.path);
    try {
      tx.signIdx(
        privateKey,
        index,
        [SigHash.DEFAULT],
        crypto.getRandomValues(new Uint8Array(32)),
      );
      const signature = tx.getInput(index).tapKeySig;
      if (!signature || signature.length !== 64) {
        throw new Error(`Taproot input ${index} did not produce a SIGHASH_DEFAULT signature`);
      }
      const digest = tx.preimageWitnessV1(index, prevOutScripts, SigHash.DEFAULT, amounts);
      const expectedPublicKey = fromHex(coin.scriptPubKey).slice(2);
      if (!schnorr.verify(signature, digest, expectedPublicKey)) {
        throw new Error(`Local Taproot signature verification failed for input ${index}`);
      }
    } finally {
      privateKey.fill(0);
    }
  }

  tx.finalize();
  if (tx.vsize !== template.vsize) {
    throw new Error(`Transaction size changed from ${template.vsize} to ${tx.vsize} vB`);
  }
  if (tx.fee !== BigInt(template.fee)) throw new Error("Transaction fee changed while signing");
  return {
    rawTx: tx.hex,
    txid: tx.id,
    vsize: tx.vsize,
    fee: template.fee,
    outputValue: template.outputValue,
  };
}
