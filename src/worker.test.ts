import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker, canonicalJson, type Job } from "./worker.js";
import { Backend, type FetchLike } from "./backend.js";
import { generateKey } from "./keys.js";
import { workerIdToPublicKey } from "./keys.js";
import { verifyReceipt, sha256, linkHash, type Receipt } from "./receipt.js";
import type { Config } from "./config.js";

const config: Config = {
  gateway: "https://gw.test",
  backend: "http://localhost:11434/v1",
  models: ["llama3.1:8b", "qwen2.5:7b"],
  pollMs: 250,
};

interface Call {
  url: string;
  init: RequestInit;
}

/**
 * Route mock fetch by URL. `gateway` and `backend` handlers receive the call
 * and must return a Response. Records every call for assertions.
 */
function router(handlers: {
  next?: (call: Call) => Response;
  result?: (call: Call) => Response;
  backend?: (call: Call) => Response;
}): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const call = { url, init: init ?? {} };
    calls.push(call);
    if (url.includes("/jobs/next")) return (handlers.next ?? notFound)(call);
    if (url.includes("/result")) return (handlers.result ?? ok)(call);
    if (url.includes("/chat/completions")) return (handlers.backend ?? ok)(call);
    return notFound(call);
  }) as FetchLike;
  return { fetch, calls };
}

const ok = (_call: Call) => new Response(JSON.stringify({ ok: true }), { status: 200 });
const notFound = (_call: Call) => new Response("not found", { status: 404 });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function sampleJob(): Job {
  return {
    id: "job-123",
    params: { model: "llama3.1:8b", messages: [{ role: "user", content: "hello world" }] },
  };
}

test("pollOnce returns null on HTTP 204", async () => {
  const { fetch } = router({ next: () => new Response(null, { status: 204 }) });
  const worker = new Worker({ config, key: generateKey(), fetch });
  assert.equal(await worker.pollOnce(), null);
});

test("pollOnce returns a job on HTTP 200 and sends the models query", async () => {
  const job = sampleJob();
  const { fetch, calls } = router({ next: () => json(job) });
  const worker = new Worker({ config, key: generateKey(), fetch });
  const got = await worker.pollOnce();
  assert.deepEqual(got, job);
  assert.match(calls[0]!.url, /models=llama3\.1%3A8b%2Cqwen2\.5%3A7b/);
});

test("pollOnce throws on a non-2xx, non-204 status", async () => {
  const { fetch } = router({ next: () => new Response("upstream", { status: 500 }) });
  const worker = new Worker({ config, key: generateKey(), fetch });
  await assert.rejects(() => worker.pollOnce(), /gateway poll 500/);
});

test("serve runs the backend then POSTs a result whose receipt VERIFIES", async () => {
  const job = sampleJob();
  const backendOutput = {
    id: "cmpl-9",
    model: "llama3.1:8b",
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  };
  let posted: { output: unknown; receipt: Receipt; link: string } | undefined;
  const { fetch } = router({
    backend: () => json(backendOutput),
    result: (call) => {
      posted = JSON.parse(String(call.init.body));
      return ok(call);
    },
  });

  const key = generateKey();
  const worker = new Worker({ config, key, fetch });
  const result = await worker.serve(job);

  // The receipt posted to the gateway is the one serve() returned.
  assert.ok(posted);
  assert.deepEqual(posted!.receipt, result.receipt);
  assert.equal(posted!.link, result.link);

  // It verifies against the worker's public key, reimported from the workerId.
  const pub = workerIdToPublicKey(key.workerId);
  assert.equal(verifyReceipt(result.receipt, pub), true);
  assert.equal(result.receipt.worker, key.workerId);

  // The link the worker advertised is the real linkHash of the receipt.
  assert.equal(result.link, linkHash(result.receipt));
});

test("serve binds requestHash and outputDigest to the actual inputs", async () => {
  const job = sampleJob();
  const backendOutput = { id: "cmpl-x", choices: [{ message: { role: "assistant", content: "ok" } }] };
  const { fetch } = router({ backend: () => json(backendOutput) });

  const worker = new Worker({ config, key: generateKey(), fetch });
  const { receipt } = await worker.serve(job);

  // Re-derive the digests independently and assert they match the receipt.
  assert.equal(receipt.requestHash, sha256(canonicalJson(job.params)));
  assert.equal(receipt.outputDigest, sha256(canonicalJson(backendOutput)));
  assert.equal(receipt.model, "llama3.1:8b");
});

test("serve threads prev: second receipt links to the first", async () => {
  const out = { choices: [{ message: { role: "assistant", content: "a" } }] };
  const { fetch } = router({ backend: () => json(out) });
  const worker = new Worker({ config, key: generateKey(), fetch });

  const first = await worker.serve({ ...sampleJob(), id: "j1" });
  const second = await worker.serve({ ...sampleJob(), id: "j2" });

  assert.equal(first.receipt.prev, "");
  assert.equal(second.receipt.prev, first.link);
});

test("serve honors an explicit prevReceipt from the job", async () => {
  const out = { choices: [{ message: { role: "assistant", content: "a" } }] };
  const { fetch } = router({ backend: () => json(out) });
  const worker = new Worker({ config, key: generateKey(), fetch });
  const explicit = sha256("server-supplied-prev");
  const { receipt } = await worker.serve({ ...sampleJob(), prevReceipt: explicit });
  assert.equal(receipt.prev, explicit);
});

test("serve surfaces a backend error", async () => {
  const { fetch } = router({ backend: () => new Response("oom", { status: 500 }) });
  const worker = new Worker({ config, key: generateKey(), fetch });
  await assert.rejects(() => worker.serve(sampleJob()), /backend chat\/completions 500/);
  // A failed serve must not increment the served counter.
  assert.equal(worker.stats.served, 0);
});

test("serve surfaces a gateway result-post error", async () => {
  const out = { choices: [{ message: { role: "assistant", content: "a" } }] };
  const { fetch } = router({ backend: () => json(out), result: () => new Response("no", { status: 502 }) });
  const worker = new Worker({ config, key: generateKey(), fetch });
  await assert.rejects(() => worker.serve(sampleJob()), /gateway result 502/);
  assert.equal(worker.stats.served, 0);
});

test("reliability starts at 1 and reflects served count", async () => {
  const out = { choices: [{ message: { role: "assistant", content: "a" } }] };
  const { fetch } = router({ backend: () => json(out) });
  const worker = new Worker({ config, key: generateKey(), fetch });
  assert.equal(worker.stats.reliability, 1);
  await worker.serve(sampleJob());
  await worker.serve(sampleJob());
  assert.equal(worker.stats.served, 2);
  assert.equal(worker.stats.reliability, 1);
});

test("runForever counts failures and reliability drops, then stops", async () => {
  let polls = 0;
  const { fetch } = router({
    next: () => {
      polls++;
      // First two polls hand out a job whose backend will fail; then stop.
      if (polls <= 2) return json(sampleJob());
      return new Response(null, { status: 204 });
    },
    backend: () => new Response("fail", { status: 500 }),
  });
  const fastConfig: Config = { ...config, pollMs: 250 };
  const worker = new Worker({ config: fastConfig, key: generateKey(), fetch });

  const run = worker.runForever();
  // Let a couple of poll/serve cycles happen, then stop.
  await new Promise((r) => globalThis.setTimeout(r, 60));
  worker.stop();
  await run;

  assert.ok(worker.stats.failed >= 1, `expected >=1 failure, got ${worker.stats.failed}`);
  assert.ok(worker.stats.reliability < 1);
});

test("runForever returns promptly when stopped while idle", async () => {
  const { fetch } = router({ next: () => new Response(null, { status: 204 }) });
  const worker = new Worker({ config, key: generateKey(), fetch });
  const run = worker.runForever();
  worker.stop();
  await run; // should resolve without hanging
  assert.ok(true);
});

test("worker can be constructed with an injected Backend", async () => {
  const out = { choices: [{ message: { role: "assistant", content: "z" } }] };
  const { fetch } = router({ backend: () => json(out) });
  const backend = new Backend({ baseURL: config.backend, fetch });
  const worker = new Worker({ config, key: generateKey(), fetch, backend });
  const { receipt } = await worker.serve(sampleJob());
  assert.equal(receipt.outputDigest, sha256(canonicalJson(out)));
});

test("canonicalJson is key-order independent", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.equal(canonicalJson({ a: { y: 1, x: 2 } }), canonicalJson({ a: { x: 2, y: 1 } }));
});
