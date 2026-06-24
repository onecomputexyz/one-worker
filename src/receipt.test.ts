import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newKeyPair,
  signReceipt,
  verifyReceipt,
  sha256,
  linkHash,
  canonical,
  ReceiptChain,
  type Receipt,
} from "./receipt.js";
import { publicKeyToWorkerId } from "./keys.js";

const base: Receipt = {
  prev: "",
  requestHash: sha256("the request"),
  model: "llama3.1:8b",
  worker: "pubkey",
  outputDigest: sha256("the output"),
};

test("signs and verifies a receipt", () => {
  const { privateKey, publicKey } = newKeyPair();
  const signed = signReceipt(base, privateKey);
  assert.ok(signed.sig);
  assert.equal(verifyReceipt(signed, publicKey), true);
});

test("tampered output fails verification", () => {
  const { privateKey, publicKey } = newKeyPair();
  const signed = signReceipt(base, privateKey);
  const forged = { ...signed, outputDigest: sha256("evil output") };
  assert.equal(verifyReceipt(forged, publicKey), false);
});

test("tampered requestHash fails verification", () => {
  const { privateKey, publicKey } = newKeyPair();
  const signed = signReceipt(base, privateKey);
  const forged = { ...signed, requestHash: sha256("different request") };
  assert.equal(verifyReceipt(forged, publicKey), false);
});

test("wrong key fails verification", () => {
  const { privateKey } = newKeyPair();
  const other = newKeyPair();
  const signed = signReceipt(base, privateKey);
  assert.equal(verifyReceipt(signed, other.publicKey), false);
});

test("missing signature does not verify", () => {
  const { publicKey } = newKeyPair();
  assert.equal(verifyReceipt(base, publicKey), false);
});

test("garbage signature does not throw and does not verify", () => {
  const { publicKey } = newKeyPair();
  const forged = { ...base, sig: "not-valid-base64-!!!" };
  assert.equal(verifyReceipt(forged, publicKey), false);
});

test("canonical serialization is order-independent and stable", () => {
  const reordered: Receipt = {
    outputDigest: base.outputDigest,
    worker: base.worker,
    model: base.model,
    requestHash: base.requestHash,
    prev: base.prev,
  };
  assert.equal(canonical(base), canonical(reordered));
});

test("linkHash is stable and chains", () => {
  const { privateKey } = newKeyPair();
  const a = signReceipt(base, privateKey);
  assert.equal(linkHash(a), linkHash(a));
  const next = signReceipt(
    { ...base, prev: linkHash(a), outputDigest: sha256("next") },
    privateKey,
  );
  assert.equal(next.prev, linkHash(a));
});

test("ReceiptChain appends, links prev, and verifies", () => {
  const { privateKey, publicKey } = newKeyPair();
  const chain = new ReceiptChain(privateKey, publicKey);

  const r0 = chain.append({ requestHash: sha256("req0"), model: "m", outputDigest: sha256("out0") });
  const r1 = chain.append({ requestHash: sha256("req1"), model: "m", outputDigest: sha256("out1") });
  const r2 = chain.append({ requestHash: sha256("req2"), model: "m", outputDigest: sha256("out2") });

  assert.equal(chain.length, 3);
  assert.equal(r0.prev, "");
  assert.equal(r1.prev, linkHash(r0));
  assert.equal(r2.prev, linkHash(r1));
  // worker id is auto-populated from the chain's public key
  assert.equal(r0.worker, publicKeyToWorkerId(publicKey));

  const result = chain.verify();
  assert.equal(result.ok, true);
  assert.equal(result.badIndex, -1);
});

test("ReceiptChain detects a tampered link mid-chain", () => {
  const { privateKey, publicKey } = newKeyPair();
  const chain = new ReceiptChain(privateKey, publicKey);
  chain.append({ requestHash: sha256("a"), model: "m", outputDigest: sha256("oa") });
  chain.append({ requestHash: sha256("b"), model: "m", outputDigest: sha256("ob") });
  chain.append({ requestHash: sha256("c"), model: "m", outputDigest: sha256("oc") });
  chain.append({ requestHash: sha256("d"), model: "m", outputDigest: sha256("od") });

  // Mutate the stored receipt at index 2's output (breaks its signature).
  const stored = chain.list();
  stored[2]!.outputDigest = sha256("EVIL");
  const reloaded = ReceiptChain.from(stored, privateKey, publicKey);

  const result = reloaded.verify();
  assert.equal(result.ok, false);
  assert.equal(result.badIndex, 2);
});

test("ReceiptChain detects a broken prev link", () => {
  const { privateKey, publicKey } = newKeyPair();
  const chain = new ReceiptChain(privateKey, publicKey);
  chain.append({ requestHash: sha256("a"), model: "m", outputDigest: sha256("oa") });
  chain.append({ requestHash: sha256("b"), model: "m", outputDigest: sha256("ob") });

  const stored = chain.list();
  // Re-sign index 1 with a corrupted prev so the signature is valid but the
  // link is wrong — isolates the prev-mismatch path from the signature path.
  const tampered: Receipt = signReceipt(
    { ...stored[1]!, sig: undefined, prev: sha256("wrong-prev") },
    privateKey,
  );
  stored[1] = tampered;
  const reloaded = ReceiptChain.from(stored, privateKey, publicKey);

  const result = reloaded.verify();
  assert.equal(result.ok, false);
  assert.equal(result.badIndex, 1);
  assert.match(result.reason ?? "", /link/);
});

test("ReceiptChain fails verification under a foreign public key", () => {
  const { privateKey, publicKey } = newKeyPair();
  const stranger = newKeyPair();
  const chain = new ReceiptChain(privateKey, publicKey);
  chain.append({ requestHash: sha256("a"), model: "m", outputDigest: sha256("oa") });
  const result = chain.verify(stranger.publicKey);
  assert.equal(result.ok, false);
  assert.equal(result.badIndex, 0);
});

test("empty ReceiptChain verifies trivially and head() is empty", () => {
  const { privateKey, publicKey } = newKeyPair();
  const chain = new ReceiptChain(privateKey, publicKey);
  assert.equal(chain.head(), "");
  const result = chain.verify();
  assert.equal(result.ok, true);
  assert.equal(result.badIndex, -1);
});
