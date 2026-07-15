/**
 * Durable, dedup'd usage recording for {@link ManagedSessionRuntime} (ROB-7 / ROB-14).
 *
 * The runtime records one usage row per model request (the Pi `turn_end` event, §9.7). Two
 * failure modes this wrapper closes:
 *
 * - **Double-count (ROB-7).** Every model request is keyed by a stable idempotency key
 *   (the provider `responseId`, or a per-runtime sequence when absent). A repeated key — a
 *   duplicated `turn_end`, or a retry of an already-recorded request — is a no-op, so the
 *   same request can never be billed twice.
 * - **Silent drop on a transient failure (ROB-14).** `record()` is retried with bounded
 *   backoff on a transient error instead of being swallowed, and every in-flight write is
 *   awaited at turn settlement ({@link drain}) so usage is durable before the turn goes idle.
 *
 * Recording is kicked eagerly (the returned promise resolves once the row is durable) so a
 * caller that must observe the persisted usage — budget enforcement — can await exactly the
 * request it just recorded.
 */

import type { SessionId, TokenCounts, UsageRecorder } from "../ports.js";
import { delay, isTransient } from "./runtime-helpers.js";

/** A model request's usage plus the idempotency key that dedups its recording. */
export interface KeyedUsage {
  /** Stable per-model-request key: retries reuse it; distinct requests differ. */
  key: string;
  model: string;
  tokens: TokenCounts;
}

/** Retry budget for a transient `record()` failure (ROB-14). */
const MAX_RECORD_RETRIES = 5;

/** Exponential backoff (ms) for the Nth retry: 50 → 100 → 200 → 400 → 800. */
function recordBackoffMs(attempt: number): number {
  return 50 * 2 ** attempt;
}

/**
 * Wraps a {@link UsageRecorder} with per-key dedup + bounded transient retry. One instance
 * per runtime; not shared across sessions (the dedup set is per-session by construction —
 * keys embed the session id).
 */
export class DurableUsageRecorder {
  /** Keys whose row is durably written (dedup — never record twice). */
  private readonly done = new Set<string>();
  /** Keys with a record in flight, so a concurrent kick coalesces onto the same promise. */
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly maxRetries: number;
  private readonly onError: (err: unknown, key: string) => void;

  constructor(
    private readonly inner: UsageRecorder,
    opts: {
      maxRetries?: number;
      /** Invoked when a record is abandoned after exhausting retries (never throws). */
      onError?: (err: unknown, key: string) => void;
    } = {},
  ) {
    this.maxRetries = opts.maxRetries ?? MAX_RECORD_RETRIES;
    this.onError = opts.onError ?? ((): void => {});
  }

  /**
   * Record `usage` for `sessionId` exactly once, keyed by `usage.key`. Returns a promise
   * that resolves when the row is durable (after any transient retries), so a caller may
   * await the specific request it recorded. A key already recorded (or in flight) resolves
   * immediately / coalesces — the request is never billed twice.
   */
  record(sessionId: SessionId, usage: KeyedUsage): Promise<void> {
    if (this.done.has(usage.key)) return Promise.resolve();
    const existing = this.inflight.get(usage.key);
    if (existing) return existing;
    const p = this.attempt(sessionId, usage)
      .then(() => {
        this.done.add(usage.key);
      })
      .catch((err: unknown) => {
        // Exhausted retries (or a non-transient error): surface to the caller's sink and
        // drop THIS attempt, but leave the key un-done so a later kick can retry it.
        this.onError(err, usage.key);
      })
      .finally(() => {
        this.inflight.delete(usage.key);
      });
    this.inflight.set(usage.key, p);
    return p;
  }

  private async attempt(sessionId: SessionId, usage: KeyedUsage): Promise<void> {
    for (let n = 0; ; n++) {
      try {
        await this.inner.record(sessionId, usage.model, usage.tokens);
        return;
      } catch (err) {
        if (n >= this.maxRetries || !isTransient(err)) throw err;
        await delay(recordBackoffMs(n));
      }
    }
  }

  /** Await every in-flight recording. Call at turn settlement so usage is durable. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inflight.values()]);
  }
}
