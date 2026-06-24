/** Default gateway URL for the ONE network. */
export const DEFAULT_GATEWAY = "https://platform.onecompute.xyz";
/** Default local OpenAI-compatible backend (Ollama). */
export const DEFAULT_BACKEND = "http://localhost:11434/v1";
/** Default model advertised when none is configured. */
export const DEFAULT_MODELS = "llama3.1:8b";
/** Default poll interval (ms). */
export const DEFAULT_POLL_MS = 2000;
/** Lower bound on the poll interval to avoid hammering the gateway. */
export const MIN_POLL_MS = 250;

/** A minimal view of the environment, so {@link loadConfig} is pure/testable. */
export type Env = Record<string, string | undefined>;

/** Fully-resolved, validated worker configuration. */
export interface Config {
  /** Gateway base URL, no trailing slash. */
  gateway: string;
  /** Backend base URL, no trailing slash. */
  backend: string;
  /** Models this worker advertises (non-empty, trimmed, de-duplicated). */
  models: string[];
  /** Raw PEM of the worker key, or undefined (=> ephemeral). */
  workerKey?: string;
  /** Poll interval in milliseconds. */
  pollMs: number;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Build a validated {@link Config} from an env object. Pure function — pass
 * `process.env` in production, or a literal in tests.
 *
 * Throws on an empty model list or an invalid poll interval so the worker fails
 * fast at startup rather than misbehaving in the poll loop.
 */
export function loadConfig(env: Env = process.env): Config {
  const gateway = stripTrailingSlash((env.ONE_GATEWAY ?? DEFAULT_GATEWAY).trim());
  const backend = stripTrailingSlash((env.ONE_BACKEND ?? DEFAULT_BACKEND).trim());

  if (!gateway) throw new Error("ONE_GATEWAY must not be empty");
  if (!backend) throw new Error("ONE_BACKEND must not be empty");

  const models = dedupe(
    (env.ONE_MODELS ?? DEFAULT_MODELS)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (models.length === 0) {
    throw new Error("ONE_MODELS must list at least one model");
  }

  const pollRaw = env.ONE_POLL_MS ?? String(DEFAULT_POLL_MS);
  const pollMs = Number(pollRaw);
  if (!Number.isFinite(pollMs) || !Number.isInteger(pollMs) || pollMs < MIN_POLL_MS) {
    throw new Error(
      `ONE_POLL_MS must be an integer >= ${MIN_POLL_MS} (got ${JSON.stringify(pollRaw)})`,
    );
  }

  const workerKey = env.ONE_WORKER_KEY?.trim() || undefined;

  return { gateway, backend, models, workerKey, pollMs };
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}
