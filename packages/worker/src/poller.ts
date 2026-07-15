/**
 * Always-on poller (WP-4.2, §10.4).
 *
 * Outbound-HTTPS-only: the worker never listens. On each tick it claims the next
 * queued work item (`POST /v1/environments/:id/work-claim`), executes it via the
 * configured {@link Executor}, and posts each tool result back as a
 * `user.tool_result` event (`POST /v1/sessions/:id/work-result`). Idles at
 * `pollingIntervalMs` when the queue is empty.
 *
 * `fetchImpl` is injected (defaults to global `fetch`) so tests mock the backend
 * HTTP without `msw` or a real server.
 */

import type { WorkerConfig } from "./config.js";
import {
  type Executor,
  type WorkItem,
  type ToolResult,
} from "./control-levels.js";

/** Minimal fetch shape (subset of global fetch) — injectable for tests. */
export interface FetchLike {
  (input: string, init?: FetchInit): Promise<FetchResponse>;
}
export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}
export interface FetchResponse {
  status: number;
  ok: boolean;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/** Minimal pino-like logger (keeps the worker dependency-free). */
export interface WorkerLogger {
  info?(obj: unknown, msg?: string): void;
  warn?(obj: unknown, msg?: string): void;
  error?(obj: unknown, msg?: string): void;
}
const noopLogger: WorkerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Adapt global fetch to {@link FetchLike}. */
const defaultFetch: FetchLike = async (input, init) => {
  const res = await fetch(input, init);
  return {
    status: res.status,
    ok: res.ok,
    text: () => res.text(),
    json: () => res.json(),
  };
};

/** Generate an Idempotency-Key (the backend requires it on mutating POSTs). */
function idempotencyKey(): string {
  // crypto.randomUUID is available on Node 19+ (runtime is Node 26). Fall back
  // to a timestamp+random shape for older runtimes.
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `wk_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export interface PollerOptions {
  fetchImpl?: FetchLike;
  logger?: WorkerLogger;
  /** Abort the poller. Required for `start()` to ever stop. */
  signal?: AbortSignal;
  /** Override interval (defaults to config). Mainly for tests. */
  intervalMs?: number;
}

/**
 * Always-on worker poller. One instance per worker process.
 *
 * Lifecycle: `start()` loops until the abort signal fires. `pollOnce()` does a
 * single claim→execute→postResult round-trip (used by webhook mode + tests).
 */
export class Poller {
  private readonly cfg: WorkerConfig;
  private readonly executor: Executor;
  private readonly fetchImpl: FetchLike;
  private readonly logger: WorkerLogger;
  private readonly signal?: AbortSignal;
  private readonly intervalMs: number;

  constructor(cfg: WorkerConfig, executor: Executor, opts: PollerOptions = {}) {
    this.cfg = cfg;
    this.executor = executor;
    this.fetchImpl = opts.fetchImpl ?? defaultFetch;
    this.logger = opts.logger ?? noopLogger;
    this.signal = opts.signal;
    this.intervalMs = opts.intervalMs ?? cfg.pollingIntervalMs;
  }

  /** Run the poll loop until aborted. Resolves when the signal fires. */
  async start(): Promise<void> {
    this.logger.info?.({ env: this.cfg.environmentId, mode: "poll" }, "worker poller started");
    while (!this.signal?.aborted) {
      try {
        await this.pollOnce();
      } catch (err) {
        // Transient backend errors don't kill the poller — back off + retry.
        this.logger.error?.(
          { err: err instanceof Error ? err.message : String(err) },
          "poll tick failed",
        );
      }
      if (this.signal?.aborted) break;
      await this.sleep(this.intervalMs);
    }
    this.logger.info?.({}, "worker poller stopped");
  }

  /** A single claim→execute→postResult round-trip. Returns whether work was claimed. */
  async pollOnce(): Promise<boolean> {
    const item = await this.claim();
    if (!item) return false;
    // Respect a pending stop request: don't execute more tools (§10.4 work.stop).
    if (item.stopRequested) {
      this.logger.info?.(
        { sessionId: item.sessionId, stop: item.stopRequested },
        "claimed item has stop requested; skipping execution",
      );
      return true;
    }
    await this.executeAndPost(item);
    return true;
  }

  /** Claim the next queued work item, or `null` if the queue is empty. */
  private async claim(): Promise<WorkItem | null> {
    const url = `${this.cfg.backendUrl}/v1/environments/${encodeURIComponent(this.cfg.environmentId)}/work-claim`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: this.authHeaders(),
    });
    if (res.status === 204) return null;
    if (res.status !== 200) {
      throw new Error(`work-claim failed: HTTP ${res.status}: ${await safeText(res)}`);
    }
    return (await res.json()) as WorkItem;
  }

  /** Execute the work item's tool calls and post each result back. */
  private async executeAndPost(item: WorkItem): Promise<void> {
    let results: ToolResult[];
    try {
      results = await this.executor.execute(item);
    } catch (err) {
      // Executor blew up entirely (not per-tool) — post a single error result.
      results = [{
        tool: "executor",
        error: err instanceof Error ? err.message : String(err),
      }];
    }
    for (const result of results) {
      await this.postResult(item.sessionId, result);
    }
    this.logger.info?.(
      { sessionId: item.sessionId, posted: results.length },
      "work item executed; results posted",
    );
  }

  /** Append a `user.tool_result` event to the session's work item (§9.2). */
  async postResult(sessionId: string, result: ToolResult): Promise<void> {
    const url = `${this.cfg.backendUrl}/v1/sessions/${encodeURIComponent(sessionId)}/work-result`;
    const body = {
      type: "user.tool_result" as const,
      tool: result.tool,
      ...(result.output !== undefined ? { output: result.output } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        "Idempotency-Key": idempotencyKey(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`work-result failed: HTTP ${res.status}: ${await safeText(res)}`);
    }
  }

  /** Shared auth headers (Bearer worker key). */
  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cfg.workerKey}`,
      "X-Worker-Key-Id": this.cfg.workerKeyId,
    };
  }

  /** Sleep that aborts early when the signal fires. */
  private sleep(ms: number): Promise<void> {
    if (this.signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
    });
  }
}

async function safeText(res: FetchResponse): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
