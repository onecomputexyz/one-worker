import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadConfig,
  DEFAULT_GATEWAY,
  DEFAULT_BACKEND,
  DEFAULT_POLL_MS,
  type Env,
} from "./config.js";

test("applies defaults on an empty env", () => {
  const cfg = loadConfig({} as Env);
  assert.equal(cfg.gateway, DEFAULT_GATEWAY);
  assert.equal(cfg.backend, DEFAULT_BACKEND);
  assert.deepEqual(cfg.models, ["llama3.1:8b"]);
  assert.equal(cfg.pollMs, DEFAULT_POLL_MS);
  assert.equal(cfg.workerKey, undefined);
});

test("strips trailing slashes from URLs", () => {
  const cfg = loadConfig({
    ONE_GATEWAY: "https://gw.example.com///",
    ONE_BACKEND: "http://localhost:8000/v1/",
  });
  assert.equal(cfg.gateway, "https://gw.example.com");
  assert.equal(cfg.backend, "http://localhost:8000/v1");
});

test("parses, trims, and de-duplicates ONE_MODELS", () => {
  const cfg = loadConfig({ ONE_MODELS: " a , b ,, a , c " });
  assert.deepEqual(cfg.models, ["a", "b", "c"]);
});

test("throws on an empty model list", () => {
  assert.throws(() => loadConfig({ ONE_MODELS: "  , ,, " }), /at least one model/);
});

test("throws on a non-numeric poll interval", () => {
  assert.throws(() => loadConfig({ ONE_POLL_MS: "soon" }), /ONE_POLL_MS/);
});

test("throws on a poll interval below the minimum", () => {
  assert.throws(() => loadConfig({ ONE_POLL_MS: "10" }), /ONE_POLL_MS/);
});

test("throws on a non-integer poll interval", () => {
  assert.throws(() => loadConfig({ ONE_POLL_MS: "1500.5" }), /ONE_POLL_MS/);
});

test("accepts a valid custom poll interval", () => {
  const cfg = loadConfig({ ONE_POLL_MS: "5000" });
  assert.equal(cfg.pollMs, 5000);
});

test("carries a worker key through when set", () => {
  const cfg = loadConfig({ ONE_WORKER_KEY: "  PEMDATA  " });
  assert.equal(cfg.workerKey, "PEMDATA");
});

test("treats a blank worker key as unset", () => {
  const cfg = loadConfig({ ONE_WORKER_KEY: "   " });
  assert.equal(cfg.workerKey, undefined);
});
