import { setTimeout as sleep } from "node:timers/promises";
import { Backend, type ChatCompletionParams, type ChatCompletionResponse, type FetchLike } from "./backend.js";
import type { Config } from "./config.js";
import type { WorkerKey } from "./keys.js";
import {
  linkHash,
  sha256,
  signReceipt,
  type Receipt,
} from "./receipt.js";

/** A unit of work handed out by the gateway. */
export interface Job {
  id: string;
  params: ChatCompletionParams;
  /** linkHash of the worker's previous receipt, threading the chain. */
  prevReceipt?: string;
}

/** Outcome of serving a single job. */
export interface ServeResult {
  jobId: string;
  receipt: Receipt;
  link: string;
  output: ChatCompletionResponse;
}

/** Live counters; `reliability` is served/(served+failed). */
export interface WorkerStats {
  served: number;
  failed: number;
  reliability: number;
}

export interface WorkerOptions {
  config: Config;
  key: WorkerKey;
  /** Injectable fetch for all gateway traffic (defaults to global). */
  fetch?: FetchLike;
  /** Pre-built backend (otherwise constructed from config + fetch). */
  backend?: Backend;
}

/**
 * The worker runtime. Polls the gateway, runs inference on the local backend,
 * signs a hash-linked receipt, and posts the result. All network access is via
 * the injected fetch, so the whole lifecycle is testable without a real
 * gateway or backend.
 */
export class Worker {
  readonly config: Config;
  readonly key: WorkerKey;
  private readonly fetch: FetchLike;
  private readonly backend: Backend;

  private servedCount = 0;
  private failedCount = 0;
  /** linkHash of the last receipt we produced; seeds the next job's `prev`. */
  private lastLink = "";
  private stopped = false;
  private readonly controller = new AbortController();

  constructor(opts: WorkerOptions) {
    this.config = opts.config;
    this.key = opts.key;
    this.fetch = opts.fetch ?? fetch;
    this.backend =
      opts.backend ?? new Backend({ baseURL: opts.config.backend, fetch: this.fetch });
  }

  get stats(): WorkerStats {
    const total = this.servedCount + this.failedCount;
    return {
      served: this.servedCount,
      failed: this.failedCount,
      reliability: total === 0 ? 1 : this.servedCount / total,
    };
  }

  /** Signal-aware stop; cancels in-flight gateway requests and the loop. */
  stop(): void {
    this.stopped = true;
    this.controller.abort();
  }

  private get modelsParam(): string {
    return encodeURIComponent(this.config.models.join(","));
  }

  /**
   * Ask the gateway for one job. Returns the job, or null on HTTP 204
   * (no work available). Throws on any other non-2xx status.
   */
  async pollOnce(): Promise<Job | null> {
    const url = `${this.config.gateway}/jobs/next?models=${this.modelsParam}`;
    const res = await this.fetch(url, { signal: this.controller.signal });
    if (res.status === 204) return null;
    if (!res.ok) {
      throw new Error(`gateway poll ${res.status}: ${await safeText(res)}`);
    }
    return (await res.json()) as Job;
  }

  /**
   * Run a job end to end: invoke the backend, build and sign a receipt binding
   * request -> model -> worker -> output, then POST the result to the gateway.
   * Advances the receipt chain (lastLink) on success.
   */
  async serve(job: Job): Promise<ServeResult> {
    const output = await this.backend.chatCompletion({ ...job.params, stream: false });

    const unsigned: Receipt = {
      prev: job.prevReceipt ?? this.lastLink,
      requestHash: sha256(canonicalJson(job.params)),
      model: job.params.model,
      worker: this.key.workerId,
      outputDigest: sha256(canonicalJson(output)),
    };
    const receipt = signReceipt(unsigned, this.key.privateKey);
    const link = linkHash(receipt);

    const res = await this.fetch(
      `${this.config.gateway}/jobs/${encodeURIComponent(job.id)}/result`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ output, receipt, link }),
        signal: this.controller.signal,
      },
    );
    if (!res.ok) {
      throw new Error(`gateway result ${res.status}: ${await safeText(res)}`);
    }

    this.lastLink = link;
    this.servedCount++;
    return { jobId: job.id, receipt, link, output };
  }

  /**
   * Poll-serve loop. Sleeps `pollMs` when idle and applies exponential backoff
   * (capped) on error. Returns when {@link stop} is called or the signal aborts.
   * On serve failure the `failed` counter increments and the loop continues.
   */
  async runForever(): Promise<void> {
    let backoff = this.config.pollMs;
    const maxBackoff = Math.max(this.config.pollMs * 16, 30_000);

    while (!this.stopped) {
      try {
        const job = await this.pollOnce();
        if (!job) {
          await this.idle(this.config.pollMs);
          backoff = this.config.pollMs;
          continue;
        }
        await this.serve(job);
        backoff = this.config.pollMs;
      } catch (err) {
        if (this.stopped) break;
        this.failedCount++;
        // Only count a *serve* failure once; poll failures still back off.
        this.onError(err);
        await this.idle(backoff);
        backoff = Math.min(backoff * 2, maxBackoff);
      }
    }
  }

  /** Overridable error sink (default logs to stderr). */
  onError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`worker error: ${message}`);
  }

  private async idle(ms: number): Promise<void> {
    try {
      await sleep(ms, undefined, { signal: this.controller.signal });
    } catch {
      // Aborted sleep on stop() — swallow.
    }
  }
}

/**
 * Stable JSON for hashing. Sorts object keys recursively so the request/output
 * digests are independent of property ordering on the wire.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
