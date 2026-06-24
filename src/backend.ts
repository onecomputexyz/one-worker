/** A fetch-compatible function; injectable so the backend is fully testable. */
export type FetchLike = typeof fetch;

/** Minimal OpenAI chat-completion request shape (passthrough of extra fields). */
export interface ChatCompletionParams {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  stream?: boolean;
  [k: string]: unknown;
}

/** Minimal OpenAI chat-completion response shape. */
export interface ChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    message?: { role: string; content: string };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  [k: string]: unknown;
}

export interface BackendOptions {
  /** Base URL of the OpenAI-compatible server, e.g. http://localhost:11434/v1 */
  baseURL: string;
  /** Injectable fetch (defaults to the global). */
  fetch?: FetchLike;
  /** Optional bearer token for backends that require auth (vLLM, LM Studio). */
  apiKey?: string;
  /** Per-request timeout in milliseconds (default 120000). */
  timeoutMs?: number;
}

/** Thrown when the backend returns a non-2xx status. Carries the HTTP status. */
export class BackendError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "BackendError";
  }
}

/**
 * Thin client over a local OpenAI-compatible inference server
 * (Ollama, llama.cpp, vLLM, LM Studio, …). All I/O goes through the injected
 * fetch so it can be exercised without a real backend.
 */
export class Backend {
  private readonly baseURL: string;
  private readonly fetch: FetchLike;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;

  constructor(opts: BackendOptions) {
    if (!opts.baseURL) throw new Error("Backend requires a baseURL");
    this.baseURL = opts.baseURL.replace(/\/+$/, "");
    this.fetch = opts.fetch ?? fetch;
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) h["authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetch(`${this.baseURL}${path}`, {
        ...init,
        headers: { ...this.headers(), ...(init.headers as Record<string, string>) },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * POST /chat/completions (non-streaming). Throws {@link BackendError} on a
   * non-2xx status, with the HTTP status embedded in the message.
   */
  async chatCompletion(params: ChatCompletionParams): Promise<ChatCompletionResponse> {
    const body = JSON.stringify({ ...params, stream: false });
    const res = await this.request("/chat/completions", { method: "POST", body });
    if (!res.ok) {
      const text = await safeText(res);
      throw new BackendError(`backend chat/completions ${res.status}: ${text}`, res.status, text);
    }
    return (await res.json()) as ChatCompletionResponse;
  }

  /**
   * GET /models. Returns the advertised model ids. Tolerant of backends that do
   * not implement the endpoint — returns [] rather than throwing in that case.
   */
  async listModels(): Promise<string[]> {
    let res: Response;
    try {
      res = await this.request("/models", { method: "GET" });
    } catch {
      return [];
    }
    if (!res.ok) return [];
    try {
      const json = (await res.json()) as { data?: Array<{ id?: string }> };
      return (json.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
    } catch {
      return [];
    }
  }

  /** Liveness probe. true if /models responds at all (any HTTP status). */
  async health(): Promise<boolean> {
    try {
      const res = await this.request("/models", { method: "GET" });
      // Some backends 404 /models but are otherwise up; any HTTP reply = alive.
      return res.status < 500;
    } catch {
      return false;
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
