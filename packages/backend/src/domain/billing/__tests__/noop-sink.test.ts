/**
 * No-op billing sink unit tests (WP-5.3, §29.6).
 *
 * The default sink discards every event and resolves immediately.
 */

import { describe, expect, it } from "vitest";
import { NoopBillingSink, NOOP_BILLING_SINK } from "../noop-sink.js";
import type { MeteringEvent } from "../sink.js";

const EVENT: MeteringEvent = {
  tenantId: "tnt_01J",
  sessionId: "sess_01J",
  model: "claude-3-5-sonnet",
  inputTokens: 100,
  outputTokens: 50,
  usdCost: 0.0042,
  recordedAt: "2026-07-13T12:00:00.000Z",
};

describe("NoopBillingSink", () => {
  it("resolves without throwing", async () => {
    const sink = new NoopBillingSink();
    await expect(sink.recordMetering(EVENT)).resolves.toBeUndefined();
  });

  it("shared singleton is a BillingSink", () => {
    expect(NOOP_BILLING_SINK).toBeDefined();
    expect(typeof NOOP_BILLING_SINK.recordMetering).toBe("function");
  });
});
