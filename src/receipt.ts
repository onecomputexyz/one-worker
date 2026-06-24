import {
  createHash,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

/**
 * A signed, hash-linked receipt binding request -> model -> worker -> output.
 * This is the shared substrate for verification, billing, and settlement.
 *
 * Every field except `sig` is covered by the signature (see {@link canonical}).
 * `prev` chains a receipt to the {@link linkHash} of its predecessor, so a
 * verifier can replay an entire stream of work and detect any insertion,
 * deletion, or mutation.
 */
export interface Receipt {
  prev: string; // hex linkHash of the previous receipt ("" for the chain's genesis)
  requestHash: string; // sha256 of the request body
  model: string;
  worker: string; // worker public key, base64 (DER/SPKI)
  outputDigest: string; // sha256 of the output body
  sig?: string; // ed25519 signature over the canonical body, base64
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Canonical, signature-independent serialization. Key order is fixed on
 * purpose so that signing and verification are byte-for-byte deterministic
 * regardless of how the object was constructed.
 */
export function canonical(r: Receipt): string {
  return JSON.stringify({
    prev: r.prev,
    requestHash: r.requestHash,
    model: r.model,
    worker: r.worker,
    outputDigest: r.outputDigest,
  });
}

export function signReceipt(r: Receipt, privateKey: KeyObject): Receipt {
  const sig = sign(null, Buffer.from(canonical(r)), privateKey).toString("base64");
  return { ...r, sig };
}

export function verifyReceipt(r: Receipt, publicKey: KeyObject): boolean {
  if (!r.sig) return false;
  try {
    return verify(null, Buffer.from(canonical(r)), publicKey, Buffer.from(r.sig, "base64"));
  } catch {
    // Malformed signature material (e.g. non-base64) must not throw.
    return false;
  }
}

/** The hash that the next receipt in the chain should reference as `prev`. */
export function linkHash(r: Receipt): string {
  return sha256(canonical(r) + (r.sig ?? ""));
}

export function newKeyPair(): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync("ed25519");
}

/** Result of verifying an entire {@link ReceiptChain}. */
export interface ChainVerifyResult {
  ok: boolean;
  /** Index of the first receipt that failed verification, or -1 if all valid. */
  badIndex: number;
  /** Human-readable reason for the failure, if any. */
  reason?: string;
}

/**
 * An append-only, hash-linked sequence of receipts signed by a single worker
 * key. Each appended receipt's `prev` is automatically wired to the previous
 * receipt's {@link linkHash}, and the receipt is signed on append.
 *
 * The chain can be re-verified end to end; {@link verify} returns the index of
 * the first tampered or broken link, which is what a settlement auditor needs.
 */
export class ReceiptChain {
  private readonly receipts: Receipt[] = [];

  constructor(
    private readonly privateKey: KeyObject,
    private readonly publicKey: KeyObject,
  ) {}

  /** Number of receipts currently in the chain. */
  get length(): number {
    return this.receipts.length;
  }

  /** A defensive copy of the receipts in order. */
  list(): Receipt[] {
    return this.receipts.map((r) => ({ ...r }));
  }

  /** The {@link linkHash} of the last receipt, or "" if the chain is empty. */
  head(): string {
    const last = this.receipts[this.receipts.length - 1];
    return last ? linkHash(last) : "";
  }

  /**
   * Append a new receipt. `prev` is overwritten with the current head and the
   * receipt is signed. Returns the signed receipt that was stored.
   */
  append(fields: Omit<Receipt, "prev" | "sig" | "worker">): Receipt {
    const worker = this.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const unsigned: Receipt = {
      prev: this.head(),
      requestHash: fields.requestHash,
      model: fields.model,
      worker,
      outputDigest: fields.outputDigest,
    };
    const signed = signReceipt(unsigned, this.privateKey);
    this.receipts.push(signed);
    return { ...signed };
  }

  /**
   * Verify the whole chain: every receipt's signature must validate against
   * `publicKey`, and every `prev` must equal the previous receipt's linkHash.
   * Returns `{ ok, badIndex }` where `badIndex` is the first broken receipt.
   */
  verify(publicKey: KeyObject = this.publicKey): ChainVerifyResult {
    let expectedPrev = "";
    for (let i = 0; i < this.receipts.length; i++) {
      const r = this.receipts[i]!;
      if (r.prev !== expectedPrev) {
        return { ok: false, badIndex: i, reason: "broken link (prev mismatch)" };
      }
      if (!verifyReceipt(r, publicKey)) {
        return { ok: false, badIndex: i, reason: "bad signature" };
      }
      expectedPrev = linkHash(r);
    }
    return { ok: true, badIndex: -1 };
  }

  /**
   * Rehydrate a chain from a stored list of receipts (e.g. fetched from the
   * gateway). The list is taken as-is; call {@link verify} to validate it.
   */
  static from(
    receipts: Receipt[],
    privateKey: KeyObject,
    publicKey: KeyObject,
  ): ReceiptChain {
    const chain = new ReceiptChain(privateKey, publicKey);
    for (const r of receipts) chain.receipts.push({ ...r });
    return chain;
  }
}
