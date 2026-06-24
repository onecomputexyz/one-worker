import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  generateKey,
  loadKey,
  loadOrCreateKey,
  privateKeyToPem,
  publicKeyToWorkerId,
  workerIdToPublicKey,
} from "./keys.js";
import { signReceipt, verifyReceipt, sha256, type Receipt } from "./receipt.js";

function pem(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

test("generateKey produces an ephemeral ed25519 identity", () => {
  const k = generateKey();
  assert.equal(k.ephemeral, true);
  assert.equal(k.privateKey.asymmetricKeyType, "ed25519");
  assert.ok(k.workerId.length > 0);
});

test("loadKey derives a public key matching the private key", () => {
  const p = pem();
  const k = loadKey(p);
  assert.equal(k.ephemeral, false);
  assert.equal(k.publicKey.asymmetricKeyType, "ed25519");
  // The derived workerId must equal exporting the public key directly.
  assert.equal(k.workerId, publicKeyToWorkerId(k.publicKey));
});

test("loadOrCreateKey is ephemeral when no PEM is provided", () => {
  assert.equal(loadOrCreateKey().ephemeral, true);
  assert.equal(loadOrCreateKey("").ephemeral, true);
  assert.equal(loadOrCreateKey("   ").ephemeral, true);
});

test("loadOrCreateKey loads a provided PEM (not ephemeral)", () => {
  const k = loadOrCreateKey(pem());
  assert.equal(k.ephemeral, false);
});

test("workerId roundtrip: export -> reimport yields a working verifier", () => {
  const k = generateKey();
  const reimported = workerIdToPublicKey(k.workerId);
  const receipt: Receipt = {
    prev: "",
    requestHash: sha256("req"),
    model: "m",
    worker: k.workerId,
    outputDigest: sha256("out"),
  };
  const signed = signReceipt(receipt, k.privateKey);
  // A receipt signed by the private key verifies under the reimported pubkey.
  assert.equal(verifyReceipt(signed, reimported), true);
});

test("privateKeyToPem roundtrips through loadKey to the same workerId", () => {
  const original = generateKey();
  const exported = privateKeyToPem(original.privateKey);
  const reloaded = loadKey(exported);
  assert.equal(reloaded.workerId, original.workerId);
});

test("loadKey rejects a non-ed25519 key", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rsaPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  assert.throws(() => loadKey(rsaPem), /ed25519/);
});

test("loadKey throws on malformed PEM", () => {
  assert.throws(() => loadKey("-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----"));
});
