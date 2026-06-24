import { test } from "node:test";
import assert from "node:assert/strict";
import { Backend, BackendError, type FetchLike } from "./backend.js";

interface Call {
  url: string;
  init: RequestInit;
}

/** Build a mock fetch that records calls and returns a scripted Response. */
function mockFetch(handler: (call: Call) => Response | Promise<Response>): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as FetchLike;
  return { fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("chatCompletion posts the correct url and body and returns parsed json", async () => {
  const reply = {
    id: "cmpl-1",
    model: "llama3.1:8b",
    choices: [{ index: 0, message: { role: "assistant", content: "hi there" }, finish_reason: "stop" }],
  };
  const { fetch, calls } = mockFetch(() => json(reply));
  const backend = new Backend({ baseURL: "http://localhost:11434/v1/", fetch });

  const out = await backend.chatCompletion({
    model: "llama3.1:8b",
    messages: [{ role: "user", content: "hello" }],
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "http://localhost:11434/v1/chat/completions");
  assert.equal(calls[0]!.init.method, "POST");
  const sent = JSON.parse(String(calls[0]!.init.body));
  assert.equal(sent.model, "llama3.1:8b");
  assert.equal(sent.stream, false); // always forced off
  assert.deepEqual(sent.messages, [{ role: "user", content: "hello" }]);
  assert.deepEqual(out, reply);
});

test("chatCompletion sets content-type and optional bearer auth", async () => {
  const { fetch, calls } = mockFetch(() => json({ ok: true }));
  const backend = new Backend({ baseURL: "http://x/v1", fetch, apiKey: "secret-token" });
  await backend.chatCompletion({ model: "m", messages: [] });
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers["content-type"], "application/json");
  assert.equal(headers["authorization"], "Bearer secret-token");
});

test("chatCompletion throws BackendError with status on non-2xx", async () => {
  const { fetch } = mockFetch(() => new Response("model not found", { status: 404 }));
  const backend = new Backend({ baseURL: "http://x/v1", fetch });
  await assert.rejects(
    () => backend.chatCompletion({ model: "ghost", messages: [] }),
    (err: unknown) => {
      assert.ok(err instanceof BackendError);
      assert.equal(err.status, 404);
      assert.match(err.message, /404/);
      return true;
    },
  );
});

test("listModels parses the data array", async () => {
  const { fetch } = mockFetch(() =>
    json({ object: "list", data: [{ id: "llama3.1:8b" }, { id: "qwen2.5:7b" }] }),
  );
  const backend = new Backend({ baseURL: "http://x/v1", fetch });
  assert.deepEqual(await backend.listModels(), ["llama3.1:8b", "qwen2.5:7b"]);
});

test("listModels tolerates an unsupported endpoint (returns [])", async () => {
  const { fetch } = mockFetch(() => new Response("not implemented", { status: 404 }));
  const backend = new Backend({ baseURL: "http://x/v1", fetch });
  assert.deepEqual(await backend.listModels(), []);
});

test("listModels tolerates a network error (returns [])", async () => {
  const fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as FetchLike;
  const backend = new Backend({ baseURL: "http://x/v1", fetch });
  assert.deepEqual(await backend.listModels(), []);
});

test("health is true when the backend replies", async () => {
  const { fetch } = mockFetch(() => json({ data: [] }));
  const backend = new Backend({ baseURL: "http://x/v1", fetch });
  assert.equal(await backend.health(), true);
});

test("health is true on a 404 (alive but no /models)", async () => {
  const { fetch } = mockFetch(() => new Response("nope", { status: 404 }));
  const backend = new Backend({ baseURL: "http://x/v1", fetch });
  assert.equal(await backend.health(), true);
});

test("health is false on a connection error", async () => {
  const fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as FetchLike;
  const backend = new Backend({ baseURL: "http://x/v1", fetch });
  assert.equal(await backend.health(), false);
});

test("health is false on a 5xx", async () => {
  const { fetch } = mockFetch(() => new Response("boom", { status: 503 }));
  const backend = new Backend({ baseURL: "http://x/v1", fetch });
  assert.equal(await backend.health(), false);
});

test("constructor rejects an empty baseURL", () => {
  assert.throws(() => new Backend({ baseURL: "" }), /baseURL/);
});
