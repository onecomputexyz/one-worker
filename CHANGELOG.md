# Changelog

All notable changes to `@onecompute/worker` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-06-25

Initial release.

### Added
- `Worker` runtime: `pollOnce` → `serve` → `runForever` loop with exponential backoff and abortable graceful stop (SIGINT/SIGTERM).
- ed25519 **signed, hash-linked receipts**: `Receipt`, canonical serialization, `signReceipt`/`verifyReceipt`, `linkHash`, and a `ReceiptChain` class that auto-links `prev`, signs on append, and verifies the whole chain (reports the first bad index).
- `Backend` client for any local OpenAI-compatible inference server (Ollama, llama.cpp, vLLM, LM Studio): `chatCompletion`, `listModels`, `health`.
- Key management (`keys.ts`): load an ed25519 key from PEM, derive/export the worker id (base64 SPKI/DER), or fall back to an ephemeral key (with a clear warning that payouts won't accrue).
- Pure, validated configuration from environment variables (`loadConfig`): `ONE_GATEWAY`, `ONE_BACKEND`, `ONE_MODELS`, `ONE_WORKER_KEY`, `ONE_POLL_MS`.
- Live reliability score (`served / (served + failed)`) exposed via `worker.stats`.
- `one-worker` CLI with startup banner and library exports.
- 56 unit tests (gateway and backend fully mocked; receipts re-verified against the on-wire public key).

[Unreleased]: https://github.com/onecomputexyz/one-worker/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/onecomputexyz/one-worker/releases/tag/v0.1.0
