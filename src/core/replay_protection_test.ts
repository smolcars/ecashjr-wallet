import { deepStrictEqual, equal, throws } from "node:assert/strict";
import { RawTx, SigHash, Transaction } from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1.js";
import { fromHex, toHex } from "./bytes.ts";
import { Bip86Keychain, entropyFromMnemonic } from "./keys.ts";
import { assertWalletStateInvariants, summarizeIntent } from "./intent_state.ts";
import { emptyPublicState } from "./types.ts";
import {
  assertEcxReplayProtection,
  createSweepTemplate,
  ECX_REPLAY_LOCKTIME,
  RBF_SEQUENCE,
  signBtcSweep,
  signEcxSweep,
} from "./transaction.ts";

Deno.test("ECX marker survives signing and BIP341 signatures commit to locktime and sequences", () => {
  const entropy = entropyFromMnemonic(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  );
  const keys = new Bip86Keychain(entropy);
  try {
    const coins = [0, 1].map((index) => ({
      txid: (index ? "22" : "11").repeat(32),
      vout: index,
      value: 100_000,
      scriptPubKey: keys.derive(0, index).scriptPubKey,
      path: keys.derive(0, index).path,
    }));
    const template = createSweepTemplate(coins, keys.derive(0, 2).address, 2, 973_800);
    const signed = signEcxSweep(template, keys);
    const raw = RawTx.decode(fromHex(signed.rawTx));
    const tx = Transaction.fromRaw(fromHex(signed.rawTx));
    equal(template.lockTime, 499_999_998);
    equal(raw.lockTime, 499_999_998);
    deepStrictEqual(raw.inputs.map((i) => i.sequence), [0xffff_fffd, 0xffff_fffd]);
    assertEcxReplayProtection(tx);
    const scripts = coins.map((coin) => fromHex(coin.scriptPubKey));
    const amounts = coins.map((coin) => BigInt(coin.value));
    for (let i = 0; i < coins.length; i++) {
      const sig = raw.witnesses![i][0];
      equal(sig.length, 64);
      equal(
        schnorr.verify(
          sig,
          tx.preimageWitnessV1(i, scripts, SigHash.DEFAULT, amounts),
          scripts[i].slice(2),
        ),
        true,
      );
      const changed = Transaction.fromRaw(RawTx.encode({ ...raw, lockTime: 0 }));
      equal(
        schnorr.verify(
          sig,
          changed.preimageWitnessV1(i, scripts, SigHash.DEFAULT, amounts),
          scripts[i].slice(2),
        ),
        false,
      );
    }
    const changedSequence = Transaction.fromRaw(RawTx.encode({
      ...raw,
      inputs: raw.inputs.map((input) => ({ ...input, sequence: 0xffff_fffe })),
    }));
    equal(
      schnorr.verify(
        raw.witnesses![0][0],
        changedSequence.preimageWitnessV1(0, scripts, SigHash.DEFAULT, amounts),
        scripts[0].slice(2),
      ),
      false,
    );
    // Bitcoin's IsFinalTx: below LOCKTIME_THRESHOLD, the marker is a future height;
    // any non-final input causes rejection at current heights (ECX special-cases it).
    equal(raw.lockTime < 500_000_000, true);
    equal(raw.lockTime < 973_800, false);
    equal(raw.inputs.every((i) => i.sequence === 0xffff_ffff), false);
    for (const lockTime of [0, ECX_REPLAY_LOCKTIME - 1, 499_999_999, 500_000_000]) {
      throws(
        () => assertEcxReplayProtection(Transaction.fromRaw(RawTx.encode({ ...raw, lockTime }))),
        /replay protection/,
      );
    }
    const finalRaw = { ...raw, inputs: raw.inputs.map((i) => ({ ...i, sequence: 0xffff_ffff })) };
    throws(
      () => assertEcxReplayProtection(Transaction.fromRaw(RawTx.encode(finalRaw))),
      /replay protection/,
    );
    // One non-final input is sufficient, but our signer applies it to every input.
    finalRaw.inputs[1].sequence = RBF_SEQUENCE;
    assertEcxReplayProtection(Transaction.fromRaw(RawTx.encode(finalRaw)));
    for (
      const mutate of [
        () => {
          template.tx.lockTime = 0;
        },
        () => {
          template.tx.lockTime = ECX_REPLAY_LOCKTIME;
          template.tx.inputs[0].sequence = 0xffff_ffff;
        },
      ]
    ) {
      mutate();
      throws(() => signEcxSweep(template, keys), /replay-protected/);
    }
    const btc = signBtcSweep(
      createSweepTemplate(coins, keys.derive(0, 2).address, 2, 973_800, "btc-standard"),
      keys,
    );
    equal(Transaction.fromRaw(fromHex(btc.rawTx)).lockTime, 973_800);
    throws(
      () => assertEcxReplayProtection(Transaction.fromRaw(fromHex(btc.rawTx))),
      /replay protection/,
    );

    const state = emptyPublicState();
    state.intents.push({
      id: crypto.randomUUID(),
      kind: "ecx-protected",
      chain: "ecx",
      phase: "prepared",
      createdAt: new Date().toISOString(),
      txid: signed.txid,
      rawTx: signed.rawTx,
      inputOutpoints: coins.map((coin) => `${coin.txid}:${coin.vout}`),
      sharedOutpoints: [],
      parentReplayIntentIds: [],
    });
    assertWalletStateInvariants(state);
    const unprotected = RawTx.encode({ ...raw, lockTime: 0 });
    state.intents[0].rawTx = toHex(unprotected);
    state.intents[0].txid = Transaction.fromRaw(unprotected).id;
    throws(() => assertWalletStateInvariants(state), /replay protection/);
    // Current policy must not prevent loading abandoned transaction history.
    state.intents[0].phase = "abandoned";
    state.intents[0].abandonedAt = new Date().toISOString();
    assertWalletStateInvariants(state);
    equal(state.intents[0].rawTx, toHex(unprotected));
    equal(summarizeIntent(state.intents[0], state.intents).canRebroadcast, false);
  } finally {
    keys.destroy();
    entropy.fill(0);
  }
});
