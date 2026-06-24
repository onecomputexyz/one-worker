#!/usr/bin/env node
import { loadConfig, type Config } from "./config.js";
import { loadOrCreateKey, type WorkerKey } from "./keys.js";
import { Worker } from "./worker.js";

// --- Library surface: import these from "@onecompute/worker". ---
export * from "./receipt.js";
export * from "./keys.js";
export * from "./backend.js";
export * from "./config.js";
export * from "./worker.js";

function banner(config: Config, key: WorkerKey): void {
  const shortId = key.workerId.length > 24 ? `${key.workerId.slice(0, 24)}…` : key.workerId;
  console.log("ONE worker online — earn USDC from your idle GPU");
  console.log(`  gateway : ${config.gateway}`);
  console.log(`  backend : ${config.backend}`);
  console.log(`  models  : ${config.models.join(", ")}`);
  console.log(`  poll    : ${config.pollMs}ms`);
  console.log(`  worker  : ${shortId}`);
  if (key.ephemeral) {
    console.warn(
      "  ⚠ ONE_WORKER_KEY not set — using an ephemeral key; USDC payouts won't accrue across restarts.",
    );
    console.warn(
      "    Generate a persistent key: openssl genpkey -algorithm ed25519 -out worker.key",
    );
  }
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const key = loadOrCreateKey(config.workerKey);
  const worker = new Worker({ config, key });

  banner(config, key);

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${signal} received — finishing up and stopping...`);
    worker.stop();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await worker.runForever();

  const { served, failed, reliability } = worker.stats;
  console.log(
    `stopped. served=${served} failed=${failed} reliability=${(reliability * 100).toFixed(1)}%`,
  );
}

// Only run the CLI when executed directly (not when imported as a library).
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
