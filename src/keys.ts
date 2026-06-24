import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";

/**
 * A resolved worker identity: an ed25519 key pair plus the derived `workerId`
 * (the base64 SPKI/DER public key the gateway uses to address and pay you).
 */
export interface WorkerKey {
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** base64-encoded SPKI/DER public key — the worker's on-network identity. */
  workerId: string;
  /** true when the key was generated on the fly (no PEM provided). */
  ephemeral: boolean;
}

/**
 * Export an ed25519 public key as base64 SPKI/DER. This is the canonical
 * `worker` identifier embedded in every receipt and used for settlement.
 */
export function publicKeyToWorkerId(publicKey: KeyObject): string {
  return publicKey.export({ type: "spki", format: "der" }).toString("base64");
}

/** Inverse of {@link publicKeyToWorkerId}: rebuild a KeyObject from a workerId. */
export function workerIdToPublicKey(workerId: string): KeyObject {
  return createPublicKey({
    key: Buffer.from(workerId, "base64"),
    format: "der",
    type: "spki",
  });
}

/** Export a private key as an unencrypted PKCS#8 PEM string (for persistence). */
export function privateKeyToPem(privateKey: KeyObject): string {
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

/**
 * Load a private key from a PEM string and derive everything else. Throws if
 * the PEM is not a valid ed25519 private key.
 */
export function loadKey(pem: string): WorkerKey {
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `unsupported key type ${privateKey.asymmetricKeyType ?? "unknown"}: ONE workers require ed25519`,
    );
  }
  const publicKey = createPublicKey(privateKey);
  return {
    privateKey,
    publicKey,
    workerId: publicKeyToWorkerId(publicKey),
    ephemeral: false,
  };
}

/** Generate a brand-new ed25519 worker identity (marked ephemeral). */
export function generateKey(): WorkerKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKey,
    workerId: publicKeyToWorkerId(publicKey),
    ephemeral: true,
  };
}

/**
 * Load a worker key from PEM if provided, otherwise generate an ephemeral one.
 * Ephemeral keys work for testing but do not accrue USDC across restarts, since
 * the network pays the public key and a fresh key has no settlement history.
 */
export function loadOrCreateKey(pem?: string): WorkerKey {
  const trimmed = pem?.trim();
  if (trimmed) return loadKey(trimmed);
  return generateKey();
}
