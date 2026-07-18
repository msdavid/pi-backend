/**
 * Metering aggregator + threshold-crossing unit tests (WP-C5.2, §11.4/§11.6).
 *
 * Pure/aggregation-level coverage (no DB): the aggregator buckets per-request
 * metering into per-`(tenant, bucket)` accumulators and flushes CLOSED buckets as
 * one aggregated {@link MeteringEvent} (§11.4: time-bucketed, never per-turn), and
 * {@link detectBalanceCrossings} fires exactly on the crossing boundary (§11.6). The
 * ledger drain + real webhook dispatch are covered end-to-end in
 * `metering-threshold.integration.test.ts` against a real Postgres.
 */

import { describe, expect, it } from "vitest";
import { MeteringEvent as MeteringEventSchema } from "@pi-managed/contracts";
import type { Pool } from "../../../infra/db/index.js";
import type { WebhookEventSource } from "../../webhook/event-source.js";
import {
  MeteringAggregator,
  detectBalanceCrossings,
  type MeteringRecord,
} from "../index.js";
import type { MeteringEvent, BillingSink } from "../sink.js";

/** Capturing export sink. */
class CapturingSink implements BillingSink {
  received: MeteringEvent[] = [];
  async recordMetering(event: MeteringEvent): Promise<void> {
    this.received.push(event);
  }
}

/** Records webhook emits (no threshold events expected when billing is disabled). */
function fakeEventSource(): { emits: string[]; source: WebhookEventSource } {
  const emits: string[] = [];
  return {
    emits,
    source: {
      async emit(_tenantId, type) {
        emits.push(type);
      },
    },
  };
}

/** A metering record at `recordedAt` (ms epoch). */
function rec(tenantId: string, recordedAtMs: number, usd: number): MeteringRecord {
  return {
    tenantId,
    sessionId: "sess_x",
    model: "claude-sonnet-4-5",
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationInputTokens: 10,
    cacheReadInputTokens: 20,
    usd,
    recordedAt: new Date(recordedAtMs),
  };
}

const BUCKET_MS = 60_000;
const SETTLE_MS = 5_000;

/** Aggregator with billing off (no DB touched) + injectable clock. */
function makeAggregator(nowRef: { ms: number }) {
  const sink = new CapturingSink();
  const es = fakeEventSource();
  const agg = new MeteringAggregator({
    pool: {} as Pool, // never used: billingEnabled=false ⇒ no ledger drain.
    sink,
    eventSource: es.source,
    billingEnabled: false,
    lowBalanceThresholdMicros: 2_000_000,
    bucketMs: BUCKET_MS,
    settleMs: SETTLE_MS,
    now: () => new Date(nowRef.ms),
  });
  return { agg, sink, es };
}

describe("detectBalanceCrossings (§11.6)", () => {
  const T = 2_000_000; // $2 threshold
  it("fires low exactly when crossing DOWN through the threshold (still > 0)", () => {
    expect(detectBalanceCrossings(3_000_000, 1_500_000, T)).toEqual({ low: true, exhausted: false });
  });
  it("does not re-fire low for a debit already below the line", () => {
    expect(detectBalanceCrossings(1_500_000, 1_000_000, T)).toEqual({ low: false, exhausted: false });
  });
  it("fires exhausted when crossing DOWN through 0", () => {
    expect(detectBalanceCrossings(500_000, 0, T)).toEqual({ low: false, exhausted: true });
  });
  it("a debit straight to ≤0 fires only exhausted (the low warning is moot once suspended)", () => {
    expect(detectBalanceCrossings(3_000_000, -100, T)).toEqual({ low: false, exhausted: true });
  });
  it("never fires on an upward move (a top-up)", () => {
    expect(detectBalanceCrossings(100, 3_000_000, T)).toEqual({ low: false, exhausted: false });
  });
  it("threshold 0 disables the low event (exhaustion still fires)", () => {
    expect(detectBalanceCrossings(3_000_000, 1_000_000, 0)).toEqual({ low: false, exhausted: false });
    expect(detectBalanceCrossings(1_000_000, 0, 0)).toEqual({ low: false, exhausted: true });
  });
});

describe("MeteringAggregator (§11.4)", () => {
  it("sums a tenant's requests in a bucket into ONE aggregated, schema-valid event", async () => {
    const now = { ms: 0 };
    const { agg, sink } = makeAggregator(now);
    agg.ingest(rec("tnt_a", 1_000, 0.01));
    agg.ingest(rec("tnt_a", 30_000, 0.02));
    agg.ingest(rec("tnt_a", 59_999, 0.03)); // all in bucket [0, 60000)

    now.ms = BUCKET_MS + SETTLE_MS; // bucket closed + settled
    await agg.flushDue();

    expect(sink.received).toHaveLength(1);
    const evt = sink.received[0];
    // Parses against the published contract (§11.4 acceptance).
    expect(() => MeteringEventSchema.parse(evt)).not.toThrow();
    expect(evt.tenantId).toBe("tnt_a");
    expect(evt.requestCount).toBe(3);
    expect(evt.inputTokens).toBe(3000);
    expect(evt.outputTokens).toBe(1500);
    expect(evt.totalTokens).toBe(3000 + 1500 + 30 + 60);
    expect(evt.usdCost).toBeCloseTo(0.06);
    expect(evt.idempotencyKey).toBe("meter:tnt_a:0");
    expect(evt.bucketStart).toBe(new Date(0).toISOString());
    expect(evt.bucketEnd).toBe(new Date(BUCKET_MS).toISOString());
  });

  it("does not flush a bucket that has not closed + settled yet", async () => {
    const now = { ms: 0 };
    const { agg, sink } = makeAggregator(now);
    agg.ingest(rec("tnt_a", 1_000, 0.01));

    now.ms = BUCKET_MS + SETTLE_MS - 1; // one ms shy of settled
    await agg.flushDue();
    expect(sink.received).toHaveLength(0);

    now.ms = BUCKET_MS + SETTLE_MS;
    await agg.flushDue();
    expect(sink.received).toHaveLength(1);
  });

  it("keeps distinct buckets and distinct tenants separate", async () => {
    const now = { ms: 0 };
    const { agg, sink } = makeAggregator(now);
    agg.ingest(rec("tnt_a", 1_000, 0.01)); // bucket 0
    agg.ingest(rec("tnt_b", 1_000, 0.05)); // bucket 0, tenant b
    agg.ingest(rec("tnt_a", 61_000, 0.02)); // bucket 60000, tenant a

    now.ms = 3 * BUCKET_MS; // everything closed
    await agg.flushDue();

    const keys = sink.received.map((e) => e.idempotencyKey).sort();
    expect(keys).toEqual(["meter:tnt_a:0", "meter:tnt_a:60000", "meter:tnt_b:0"]);
  });

  it("flushAll drains even an un-closed (open) bucket, no threshold emits when billing off", async () => {
    const now = { ms: 0 };
    const { agg, sink, es } = makeAggregator(now);
    agg.ingest(rec("tnt_a", 1_000, 0.01));
    await agg.flushAll(); // now still 0 ⇒ bucket open, but flushAll ignores the settle gate
    expect(sink.received).toHaveLength(1);
    expect(es.emits).toHaveLength(0); // billingEnabled=false ⇒ no ledger drain, no events
  });
});
