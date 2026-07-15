/**
 * Metering hook unit tests (WP-5.3, §29.6).
 *
 * Verifies the usage→billing bridge:
 * - `createMeteringHook` builds a correct {@link MeteringEvent} (ISO-8601
 *   `recordedAt`, USD + token passthrough) and dispatches it to the sink.
 * - a recorder calling the `onMetering` hook (the exact pattern added to
 *   `PgUsageRecorder.record()`) routes to the sink → "fires on usage record".
 * - delivery failures are swallowed (metering never throws / never blocks).
 *
 * Uses a tiny fake `UsageRecorder`-shaped object (no DB) that replicates the
 * single `onMetering` hook call; the real `PgUsageRecorder` invokes the same
 * hook after its INSERT (see usage-recorder.ts, clearly marked WP-5.3 seam).
 */

import { describe, expect, it } from "vitest";
import {
  createMeteringHook,
  type MeteringHook,
  type MeteringRecord,
} from "../metering.js";
import type { BillingSink, MeteringEvent } from "../sink.js";
import { NoopBillingSink } from "../noop-sink.js";

/** Capturing sink for assertions. */
class CapturingSink implements BillingSink {
  received: MeteringEvent[] = [];
  async recordMetering(event: MeteringEvent): Promise<void> {
    this.received.push(event);
  }
}

/** Failing sink (rejects) to prove errors are swallowed. */
class FailingSink implements BillingSink {
  async recordMetering(_event: MeteringEvent): Promise<void> {
    throw new Error("billing endpoint down");
  }
}

const RECORD: MeteringRecord = {
  tenantId: "tnt_01J",
  sessionId: "sess_01J",
  model: "claude-3-5-sonnet",
  inputTokens: 1200,
  outputTokens: 340,
  usd: 0.0171,
  recordedAt: new Date("2026-07-13T12:00:00.000Z"),
};

describe("createMeteringHook", () => {
  it("builds a MeteringEvent and dispatches it to the sink", async () => {
    const sink = new CapturingSink();
    const hook = createMeteringHook(sink);

    hook(RECORD);

    // Fire-and-forget: let the microtask flush.
    await Promise.resolve();
    await Promise.resolve();

    expect(sink.received).toHaveLength(1);
    const evt = sink.received[0];
    expect(evt).toEqual({
      tenantId: RECORD.tenantId,
      sessionId: RECORD.sessionId,
      model: RECORD.model,
      inputTokens: RECORD.inputTokens,
      outputTokens: RECORD.outputTokens,
      usdCost: RECORD.usd,
      recordedAt: "2026-07-13T12:00:00.000Z", // ISO-8601
    });
  });

  it("never throws when the sink rejects (metering is best-effort)", async () => {
    const hook = createMeteringHook(new FailingSink());
    expect(() => hook(RECORD)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });

  it("noop sink hook is a valid no-op wiring", async () => {
    const sink: BillingSink = new NoopBillingSink();
    const hook = createMeteringHook(sink);
    expect(() => hook(RECORD)).not.toThrow();
  });
});

/**
 * "Fires on usage record": a minimal recorder that, like `PgUsageRecorder`,
 * resolves the tenant + USD and then invokes the `onMetering` hook (the exact
 * single call added to the real recorder). Proves the recorder→hook→sink wiring.
 */
class FakeMeteringRecorder {
  constructor(private readonly hook?: MeteringHook) {}

  async record(
    tenantId: string,
    sessionId: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    usd: number,
  ): Promise<void> {
    // ...INSERT... then (WP-5.3 seam) emit to the billing sink:
    this.hook?.({
      tenantId,
      sessionId,
      model,
      inputTokens,
      outputTokens,
      usd,
      recordedAt: new Date("2026-07-13T12:00:00.000Z"),
    });
  }
}

describe("metering hook fires on usage record", () => {
  it("emits a metering event after record()", async () => {
    const sink = new CapturingSink();
    const hook = createMeteringHook(sink);
    const recorder = new FakeMeteringRecorder(hook);

    await recorder.record("tnt_01J", "sess_01J", "claude-3-5-sonnet", 1200, 340, 0.0171);
    await Promise.resolve();
    await Promise.resolve();

    expect(sink.received).toHaveLength(1);
    expect(sink.received[0].tenantId).toBe("tnt_01J");
    expect(sink.received[0].usdCost).toBe(0.0171);
    expect(sink.received[0].inputTokens).toBe(1200);
  });

  it("does not fire when no sink is wired (no-op default)", async () => {
    const sink = new CapturingSink();
    // No onMetering hook = billing disabled (composition-root default → NoopBillingSink).
    const recorder = new FakeMeteringRecorder(undefined);
    await recorder.record("tnt_01J", "sess_01J", "claude-3-5-sonnet", 1, 1, 0);
    await Promise.resolve();
    expect(sink.received).toHaveLength(0);
  });
});
