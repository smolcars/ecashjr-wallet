import { equal, rejects } from "node:assert/strict";
import { ChainVerifier, type ForkCheckpoint, validForkCheckpoint } from "./chain_verifier.ts";
import { EsploraClient } from "./esplora.ts";

const checkpoint: ForkCheckpoint = {
  height: 973_800,
  btcHash: "11".repeat(32),
  ecxHash: "22".repeat(32),
};
class Backend extends EsploraClient {
  tip = checkpoint.height;
  hash = checkpoint.ecxHash;
  requests = 0;
  override tipHeight() {
    this.requests++;
    return Promise.resolve(this.tip);
  }
  override blockHash() {
    this.requests++;
    return Promise.resolve(this.hash);
  }
}
Deno.test("missing checkpoint fails closed before any backend request", async () => {
  const backend = new Backend("https://example.com/api");
  await rejects(
    () => new ChainVerifier().verifiedTip("ecx", backend),
    /configuration is unavailable/,
  );
  equal(backend.requests, 0);
  for (
    const invalid of [null, {}, { ...checkpoint, height: 0 }, {
      ...checkpoint,
      btcHash: checkpoint.ecxHash,
    }, { ...checkpoint, ecxHash: "bad" }]
  ) {
    equal(validForkCheckpoint(invalid), false);
  }
});
Deno.test("checkpoint rejects pre-fork and wrong-chain backends and caches by identity", async () => {
  const verifier = new ChainVerifier();
  const backend = new Backend("https://example.com/api");
  backend.tip--;
  await rejects(() => verifier.verifiedTip("ecx", backend, checkpoint), /behind/);
  backend.tip++;
  backend.hash = checkpoint.btcHash;
  await rejects(
    () => verifier.verifiedTip("ecx", backend, checkpoint),
    /failed the fork checkpoint/,
  );
  backend.hash = checkpoint.ecxHash;
  equal((await verifier.verifiedTip("ecx", backend, checkpoint)).height, checkpoint.height);
  const before = backend.requests;
  await verifier.verifiedTip("ecx", backend, checkpoint);
  equal(backend.requests - before, 1);
  await rejects(
    () => verifier.verifiedTip("btc", backend, checkpoint),
    /failed the fork checkpoint/,
  );
  await rejects(
    () => verifier.verifiedTip("ecx", backend, { ...checkpoint, ecxHash: "33".repeat(32) }),
    /failed the fork checkpoint/,
  );
});
