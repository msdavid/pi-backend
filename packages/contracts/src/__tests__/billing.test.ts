/**
 * Metering-export + threshold-event schema tests (console spec §11.4/§11.6, WP-C5.2).
 *
 * These are the published contracts a `BILLING_SINK=webhook` consumer and a
 * threshold-event consumer validate each delivery against — pin the shape so a
 * server-side change that would break them fails here.
 */

import { describe, expect, it } from "vitest";
import {
  MeteringEvent,
  TenantBalanceEventData,
  WebhookEventType,
  WebhookPayload,
  DEFAULT_LOW_BALANCE_THRESHOLD_MICROS,
  DEFAULT_METERING_BUCKET_MS,
  MICROS_PER_USD,
} from "../index.js";

describe("MeteringEvent (§11.4)", () => {
  const valid = {
    idempotencyKey: "meter:tnt_01J:0",
    tenantId: "tnt_01J",
    bucketStart: "2026-07-13T12:00:00.000Z",
    bucketEnd: "2026-07-13T12:01:00.000Z",
    requestCount: 3,
    inputTokens: 3000,
    outputTokens: 1500,
    cacheCreationInputTokens: 30,
    cacheReadInputTokens: 60,
    totalTokens: 4590,
    usdCost: 0.06,
  };

  it("accepts a well-formed aggregated event", () => {
    expect(MeteringEvent.safeParse(valid).success).toBe(true);
  });

  it("requires an idempotency key (recipient dedup)", () => {
    expect(MeteringEvent.safeParse({ ...valid, idempotencyKey: "" }).success).toBe(false);
  });

  it("rejects negative / non-integer token counts", () => {
    expect(MeteringEvent.safeParse({ ...valid, inputTokens: -1 }).success).toBe(false);
    expect(MeteringEvent.safeParse({ ...valid, requestCount: 1.5 }).success).toBe(false);
  });
});

describe("TenantBalanceEventData (§11.6)", () => {
  const valid = {
    entryId: "led_01JAZZZZZZZZZZZZZZZZZZZZZZ",
    tenantId: "tnt_01J",
    balanceMicros: 1_500_000,
    balanceUsd: 1.5,
    thresholdMicros: DEFAULT_LOW_BALANCE_THRESHOLD_MICROS,
    thresholdUsd: 2,
    lifecycle: "active" as const,
  };

  it("accepts a well-formed threshold payload", () => {
    expect(TenantBalanceEventData.safeParse(valid).success).toBe(true);
  });

  it("carries a valid lifecycle only", () => {
    expect(TenantBalanceEventData.safeParse({ ...valid, lifecycle: "past_due" }).success).toBe(false);
  });

  it("requires the stable crossing id (entryId) the consumer keys idempotency on (F2)", () => {
    const { entryId: _drop, ...noEntry } = valid;
    expect(TenantBalanceEventData.safeParse(noEntry).success).toBe(false);
    // must be a `led_`-prefixed ledger entry id (not an event id).
    expect(TenantBalanceEventData.safeParse({ ...valid, entryId: "evt_01J" }).success).toBe(false);
  });

  it("is a valid WebhookPayload.data payload", () => {
    expect(
      WebhookPayload.safeParse({
        type: "tenant.balance_low",
        id: "evt_01J",
        createdAt: "2026-07-13T12:00:00.000Z",
        data: valid,
      }).success,
    ).toBe(true);
  });
});

describe("threshold webhook event types", () => {
  it("are in the published enum", () => {
    expect(WebhookEventType.safeParse("tenant.balance_low").success).toBe(true);
    expect(WebhookEventType.safeParse("tenant.balance_exhausted").success).toBe(true);
  });
});

describe("billing defaults", () => {
  it("low-balance threshold is $2 and the bucket is 1 minute", () => {
    expect(DEFAULT_LOW_BALANCE_THRESHOLD_MICROS).toBe(2 * MICROS_PER_USD);
    expect(DEFAULT_METERING_BUCKET_MS).toBe(60_000);
  });
});
