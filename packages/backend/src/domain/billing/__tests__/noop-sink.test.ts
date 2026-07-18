/**
 * No-op billing sink unit tests (WP-5.3, §29.6).
 *
 * The default sink discards every event and resolves immediately.
 */

import { describe, expect, it } from "vitest";
import { NoopBillingSink, NOOP_BILLING_SINK } from "../noop-sink.js";
import type { MeteringEvent } from "../sink.js";

const EVENT: MeteringEvent = {
  idempotencyKey: "meter:tnt_01J:0",
  tenantId: "tnt_01J",
  bucketStart: "2026-07-13T12:00:00.000Z",
  bucketEnd: "2026-07-13T12:01:00.000Z",
  requestCount: 1,
  inputTokens: 100,
  outputTokens: 50,
  cacheCreationInputTokens: 5,
  cacheReadInputTokens: 10,
  totalTokens: 165,
  usdCost: 0.0042,
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
