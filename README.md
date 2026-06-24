# @onecompute/worker

**Earn USDC from your idle GPU.**

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-339933.svg)](https://nodejs.org)
[![type](https://img.shields.io/badge/types-included-3178c6.svg)](#programmatic-use)
[![runtime deps](https://img.shields.io/badge/runtime%20deps-0-success.svg)](#architecture)

GPU worker client for **[ONE](https://onecompute.xyz)**, the decentralized AI compute network.
Point it at any local OpenAI-compatible inference server (Ollama, llama.cpp, vLLM, LM Studio)
and it pulls jobs from the gateway, runs inference, and returns **ed25519-signed, hash-linked
receipts**. Verified work settles in **USDC** — you never touch a token, hold a balance, or take
price exposure.

---

## What a worker does

A worker is a long-running process on a machine with a GPU. It advertises the models it can run,
polls the ONE gateway for matching jobs, executes them against your local backend, and proves the
work with a cryptographic receipt. The protocol verifies the receipt and pays your public key in
USDC. There is no $ONE token in the loop on the worker side — the token gates *demand*; supply
(you) is paid in stablecoin.

## How it works

1. **Poll** — `GET /jobs/next?models=…`. The gateway returns a job for one of your advertised
   models, or `204 No Content` when there is nothing to do.
2. **Infer** — the job's OpenAI chat-completion params are forwarded to your local backend
   (`POST /chat/completions`, non-streaming).
3. **Sign a receipt** — the worker builds a `Receipt` binding `requestHash → model → worker →
   outputDigest`, links it to the previous receipt's hash (`prev`), and signs it with your
   ed25519 key.
4. **Settle** — `POST /jobs/:id/result` with the output, the signed receipt, and its link hash.
   The protocol verifies the receipt with [OneVerify](https://docs.onecompute.xyz) and credits
   USDC to your worker identity.

```
 ┌────────┐  GET /jobs/next   ┌─────────┐  POST /chat/completions  ┌──────────┐
 │ worker │ ────────────────▶ │ gateway │                          │  local   │
 │        │ ◀──── job ─────── │         │      worker ───────────▶ │ backend  │
 │        │                   │         │ ◀──── completion ─────── │ (Ollama) │
 │        │  POST /result     │         │                          └──────────┘
 │        │  {output,receipt} │         │
 │        │ ────────────────▶ │         │ ── verify receipt ──▶ settle USDC
 └────────┘                   └─────────┘
```

## Requirements

- **Node.js >= 20** (uses global `fetch`, `node:crypto`, `node:timers/promises`).
- **A local OpenAI-compatible inference backend.** Any of these work out of the box:
  - [Ollama](https://ollama.com) — `http://localhost:11434/v1` (default)
  - [llama.cpp](https://github.com/ggml-org/llama.cpp) server — `http://localhost:8080/v1`
  - [vLLM](https://github.com/vllm-project/vllm) — `http://localhost:8000/v1`
  - [LM Studio](https://lmstudio.ai) — `http://localhost:1234/v1`
- An ed25519 key (the worker generates an ephemeral one if you don't supply one, but ephemeral
  keys do not accrue settlement).

## Quick start

```bash
npm install -g @onecompute/worker

# 1. Start a backend and pull a model, e.g. with Ollama:
ollama serve &
ollama pull llama3.1:8b

# 2. Generate a persistent worker identity (your USDC payout address):
openssl genpkey -algorithm ed25519 -out worker.key

# 3. Run the worker:
ONE_MODELS="llama3.1:8b" \
ONE_BACKEND="http://localhost:11434/v1" \
ONE_WORKER_KEY="$(cat worker.key)" \
one-worker
```

Or from a clone:

```bash
git clone https://github.com/onecomputexyz/one-worker
cd one-worker
npm install
npm run build
cp .env.example .env   # edit, then export the vars
npm start
```

On startup the worker prints a banner with the gateway, backend, advertised models, and your
worker id (the base64 public key the network pays). If you did **not** set `ONE_WORKER_KEY`, it
warns that the key is ephemeral.

## Configuration reference

All configuration is via environment variables. `loadConfig()` validates them and fails fast.

| Variable          | Default                             | Meaning                                                              |
| ----------------- | ----------------------------------- | ------------------------------------------------------------------- |
| `ONE_GATEWAY`     | `https://platform.onecompute.xyz`   | ONE gateway base URL (trailing slashes stripped).                   |
| `ONE_BACKEND`     | `http://localhost:11434/v1`         | Local OpenAI-compatible backend base URL.                           |
| `ONE_MODELS`      | `llama3.1:8b`                       | Comma-separated models to advertise. Trimmed and de-duplicated. Must be non-empty. |
| `ONE_WORKER_KEY`  | *(unset → ephemeral key)*           | ed25519 private key in PKCS#8 PEM. Your USDC payout identity.       |
| `ONE_POLL_MS`     | `2000`                              | Poll interval in ms. Integer, `>= 250`. Invalid values throw.       |

## Receipts

Every served job produces a `Receipt`:

```ts
interface Receipt {
  prev: string;        // linkHash of the previous receipt ("" at genesis)
  requestHash: string; // sha256 of the canonical request body
  model: string;       // the model that ran
  worker: string;      // base64 SPKI/DER ed25519 public key (worker id)
  outputDigest: string;// sha256 of the canonical output body
  sig?: string;        // ed25519 signature over the canonical body, base64
}
```

The signature covers every field except `sig` itself, serialized in a **fixed key order**
(`canonical()`), so signing and verification are byte-for-byte deterministic. The `linkHash` of a
receipt is `sha256(canonical(receipt) + sig)`, and each new receipt sets `prev` to its
predecessor's link hash. That makes the receipts an **append-only, tamper-evident chain**: any
insertion, deletion, or mutation breaks either a signature or a link, and `ReceiptChain.verify()`
returns the index of the first bad receipt.

This is exactly what [OneVerify](https://docs.onecompute.xyz) checks before settlement: it
reimports your `worker` public key, re-derives `requestHash`/`outputDigest` from the recorded job
and output, validates the ed25519 signature, and walks the `prev` chain. Verified receipts settle;
unverifiable ones are rejected and can trigger a slashing of your bond.

## Architecture

Zero runtime dependencies — only the Node standard library. Modules under `src/`:

| Module        | Responsibility                                                                          |
| ------------- | --------------------------------------------------------------------------------------- |
| `receipt.ts`  | `Receipt` type, `sha256`, canonical serialization, `signReceipt`/`verifyReceipt`, `linkHash`, and the `ReceiptChain` class (append + whole-chain verify). |
| `keys.ts`     | ed25519 key management: load from PEM, derive/export the worker id, `loadOrCreateKey`.   |
| `backend.ts`  | `Backend` client over the local OpenAI-compatible server: `chatCompletion`, `listModels`, `health`. Injectable fetch. |
| `config.ts`   | `loadConfig(env)` — pure, validated config from environment variables.                  |
| `worker.ts`   | `Worker` runtime: `pollOnce`, `serve`, `runForever` (backoff + graceful stop), live stats. |
| `index.ts`    | CLI entry (banner, SIGINT/SIGTERM handling) and the library barrel.                     |

## Reliability & settlement

The worker tracks a live reliability score, `served / (served + failed)`, exposed via
`worker.stats`. The network keeps its own view of your reliability based on receipt verification
and latency; consistently verifiable, low-latency workers are routed more jobs. Settlement is
periodic and per-worker-key — which is why a persistent `ONE_WORKER_KEY` matters: an ephemeral key
starts every run with no history and no accrued balance.

## Programmatic use

The package ships type declarations and exports its library surface, so you can embed the worker
or reuse the receipt primitives directly.

```ts
import { Worker, loadConfig, loadOrCreateKey } from "@onecompute/worker";

const config = loadConfig(process.env);
const key = loadOrCreateKey(process.env.ONE_WORKER_KEY);
const worker = new Worker({ config, key });

const job = await worker.pollOnce();
if (job) {
  const { receipt, link } = await worker.serve(job);
  console.log("served", job.id, "→", link);
}
```

Building and verifying a receipt chain by hand:

```ts
import { ReceiptChain, newKeyPair, sha256, verifyReceipt } from "@onecompute/worker";

const { privateKey, publicKey } = newKeyPair();
const chain = new ReceiptChain(privateKey, publicKey);

const r = chain.append({
  requestHash: sha256("the request body"),
  model: "llama3.1:8b",
  outputDigest: sha256("the model output"),
});

verifyReceipt(r, publicKey);        // true
chain.verify();                     // { ok: true, badIndex: -1 }
```

## Development

```bash
npm install
npm run build      # tsc → dist/
npm test           # tsc, then node --test on dist/**/*.test.js
npm start          # run the built worker
```

Tests use only the Node built-in test runner (`node:test`) and `node:assert/strict`, with an
injected mock `fetch` — they never touch the network or a real backend.

## Security

- **Treat `ONE_WORKER_KEY` like a wallet key.** It is your USDC payout identity. Keep it out of
  source control (`*.key` and `.env` are git-ignored), and prefer `ONE_WORKER_KEY="$(cat worker.key)"`
  or a secrets manager over inlining it.
- **The private key never leaves the worker.** Only the public key (the worker id) and signatures
  are transmitted; receipts are signed locally.
- **Slashable bond.** Workers on the network post a bond. Returning unverifiable receipts or
  fabricated outputs is detectable (signatures and digests won't reconcile) and can slash that
  bond — so a correct, honest worker is the only profitable strategy.
- Ephemeral keys are for local testing only; they accrue no settlement.

## Contributing

Issues and pull requests welcome at
[github.com/onecomputexyz/one-worker](https://github.com/onecomputexyz/one-worker). Please keep the
zero-runtime-dependency constraint, add `node:test` coverage for new behavior, and run
`npm test` (clean build + all tests passing) before opening a PR.

## License

MIT © 2026 ONE Protocol · [docs](https://docs.onecompute.xyz) · [site](https://onecompute.xyz)
