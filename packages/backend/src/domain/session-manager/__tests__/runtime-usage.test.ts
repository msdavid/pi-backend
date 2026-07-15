/**
 * Unit tests for {@link DurableUsageRecorder} (ROB-7 dedup + ROB-14 durable retry).
 *
 * No Postgres: a scriptable in-memory {@link UsageRecorder} stands in so the dedup key +
 * retry logic can be exercised deterministically.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionId, TokenCounts, UsageRecorder } from "../../ports.js";
import { DurableUsageRecorder, type KeyedUsage } from "../runtime-usage.js";

const SID = "sess_x";

function tokens(input: number): TokenCounts {
  return {
    inputTokens: input,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
}

/** A UsageRecorder whose `record()` can be scripted to fail a set number of times per call. */
class ScriptableRecorder implements UsageRecorder {
  readonly recorded: Array<{ model: string; tokens: TokenCounts }> = [];
  /** Remaining failures to throw before a `record()` succeeds. */
  failuresLeft = 0;
  /** The error thrown while `failuresLeft > 0`. */
  failure: Error = new Error("transient: ECONNRESET");

  async record(_sessionId: SessionId, model: string, t: TokenCounts): Promise<void> {
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw this.failure;
    }
    this.recorded.push({ model, tokens: t });
  }
  usdCost(): number {
    return 0;
  }
  async cumulativeForSession(): Promise<never> {
    throw new Error("unused");
  }
  async checkBudget(): Promise<never> {
    throw new Error("unused");
  }
  async rollupForTenant(): Promise<never> {
    throw new Error("unused");
  }
}

const usage = (key: string, input = 100): KeyedUsage => ({
  key,
  model: "claude-sonnet-4-5",
  tokens: tokens(input),
});

describe("DurableUsageRecorder", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("records each key exactly once (a repeated key is a no-op — ROB-7)", async () => {
    const inner = new ScriptableRecorder();
    const durable = new DurableUsageRecorder(inner);

    await durable.record(SID, usage("k1"));
    await durable.record(SID, usage("k1")); // duplicate — must NOT record again
    await durable.record(SID, usage("k2"));
    await durable.drain();

    expect(inner.recorded).toHaveLength(2);
    expect(inner.recorded.map((r) => r.tokens.inputTokens)).toEqual([100, 100]);
  });

  it("retries a transient failure, then records once (ROB-14)", async () => {
    const inner = new ScriptableRecorder();
    inner.failuresLeft = 2; // fail twice, then succeed
    const durable = new DurableUsageRecorder(inner);

    const p = durable.record(SID, usage("k1"));
    await vi.advanceTimersByTimeAsync(1000); // step through the backoff delays
    await p;
    await durable.drain();

    expect(inner.recorded).toHaveLength(1);
  });

  it("coalesces a second kick for an in-flight key onto the same write", async () => {
    const inner = new ScriptableRecorder();
    inner.failuresLeft = 1;
    const durable = new DurableUsageRecorder(inner);

    const p1 = durable.record(SID, usage("k1"));
    const p2 = durable.record(SID, usage("k1")); // in flight → same promise, no 2nd write path
    expect(p2).toBe(p1);
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([p1, p2]);
    await durable.drain();

    expect(inner.recorded).toHaveLength(1);
  });

  it("does not mark a key done on a non-transient failure; a later kick can retry", async () => {
    const inner = new ScriptableRecorder();
    inner.failure = new Error("forbidden: 403"); // classified non-transient → no retry
    inner.failuresLeft = 1;
    const errors: string[] = [];
    const durable = new DurableUsageRecorder(inner, {
      onError: (_err, key) => errors.push(key),
    });

    await durable.record(SID, usage("k1")); // fails, surfaced to onError, key stays un-done
    expect(errors).toEqual(["k1"]);
    expect(inner.recorded).toHaveLength(0);

    // A later kick with the same key retries (the failure budget is now spent → succeeds).
    await durable.record(SID, usage("k1"));
    await durable.drain();
    expect(inner.recorded).toHaveLength(1);
  });
});
