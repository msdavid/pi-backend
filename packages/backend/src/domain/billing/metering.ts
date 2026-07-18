/**
 * Metering aggregator (console spec §11.4, WP-C5.2) — the usage→billing bridge.
 *
 * §11.4 requires the `BILLING_SINK=webhook` export to be **time-bucketed and
 * aggregated, never per-turn**. This aggregator is the `onMetering` hook the usage
 * recorder calls after each successful `record()` (§9.7): it accumulates every model
 * request into an in-memory per-`(tenant, wall-clock bucket)` accumulator, and a
 * flush loop, once a bucket has closed (plus a small settle grace), emits ONE
 * aggregated {@link MeteringEvent} to the configured {@link BillingSink}.
 *
 * The same closed-bucket flush also **drains the local ledger** (when billing is
 * enabled): it debits the bucket's marked-up USD cost through
 * {@link appendEntryWithThresholdEvents}, which is what makes fail-soft suspension
 * enforcement (§11.1) and the threshold webhook events (§11.6) actually fire in
 * production. Both sides are idempotent per `(tenant, bucketStart)`: the export
 * dedups on the event's `idempotencyKey`, the debit on the ledger's UNIQUE key — so
 * a re-flush (transient DB error, retried next tick) never double-bills or
 * double-drains.
 *
 * **Durability.** The accumulator is in-memory. `flushAll()` drains it on graceful
 * shutdown; a hard crash loses at most one un-flushed bucket window per tenant
 * (default 60 s). That is a bounded UNDER-count of an already-best-effort export
 * seam and of a prepaid balance guarded by concurrency/idle caps (§11.1) — never an
 * over-charge (idempotency forbids it). A fully durable variant would flush from the
 * `usage_records` table instead; deferred as future hardening (see the WP report).
 *
 * No new deps.
 */

import type { Logger } from "pino";
import { MICROS_PER_USD, DEFAULT_METERING_BUCKET_MS } from "@pi-managed/contracts";
import type { MeteringEvent } from "@pi-managed/contracts";
import type { Pool } from "../../infra/db/index.js";
import type { SessionId, TenantId } from "../ports.js";
import type { WebhookEventSource } from "../webhook/event-source.js";
import type { BillingSink } from "./sink.js";
import { getBillingRow } from "./ledger.js";
import { appendEntryWithThresholdEvents } from "./threshold.js";

/**
 * The payload the recorder passes to the metering hook after a successful
 * `record()`. `recordedAt` is the wall-clock `Date` of the call, used to place the
 * request in its time bucket.
 */
export interface MeteringRecord {
  tenantId: TenantId;
  sessionId: SessionId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** USD cost derived by the recorder's price table (§9.7). */
  usd: number;
  recordedAt: Date;
}

/**
 * The hook the recorder calls (fire-and-forget, synchronous). Accumulates into the
 * aggregator's in-memory buffer; any delivery/drain happens later on the flush loop.
 */
export type MeteringHook = (record: MeteringRecord) => void;

/** Default grace after a bucket closes before it is flushed (late-committed rows). */
export const DEFAULT_METERING_SETTLE_MS = 5_000;

/** One tenant's running totals for a single time bucket. */
interface BucketAccumulator {
  tenantId: string;
  bucketStartMs: number;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  usd: number;
}

export interface MeteringAggregatorOptions {
  pool: Pool;
  /** Export sink for the aggregated events (§11.4). */
  sink: BillingSink;
  /** Event source for the threshold events fired by the ledger drain (§11.6). */
  eventSource: WebhookEventSource;
  /**
   * Whether to drain the local ledger from usage (§11.1 saas switch). Off for
   * solo/team — no drain, no threshold events. The export runs regardless (it is
   * gated by the sink selection, not by this flag).
   */
  billingEnabled: boolean;
  /** Low-balance threshold (µUSD) for `tenant.balance_low` (§11.6). */
  lowBalanceThresholdMicros: number;
  /** Aggregation bucket width (ms). Defaults to {@link DEFAULT_METERING_BUCKET_MS}. */
  bucketMs?: number;
  /** Settle grace after a bucket closes. Defaults to {@link DEFAULT_METERING_SETTLE_MS}. */
  settleMs?: number;
  /** Flush poll interval (ms). Defaults to `bucketMs`. */
  flushIntervalMs?: number;
  logger?: Logger;
  /** Injectable clock (tests). */
  now?: () => Date;
}

/**
 * Buffers per-request metering into per-`(tenant, bucket)` accumulators and flushes
 * closed buckets to the export sink + the ledger. One instance per service; the
 * composition root wires {@link ingest} as the recorder's `onMetering` hook and
 * runs {@link start}/{@link stop} + a shutdown {@link flushAll}.
 */
export class MeteringAggregator {
  private readonly pool: Pool;
  private readonly sink: BillingSink;
  private readonly eventSource: WebhookEventSource;
  private readonly billingEnabled: boolean;
  private readonly thresholdMicros: number;
  private readonly bucketMs: number;
  private readonly settleMs: number;
  private readonly flushIntervalMs: number;
  private readonly logger?: Logger;
  private readonly now: () => Date;
  private readonly buckets = new Map<string, BucketAccumulator>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private flushing = false;

  constructor(opts: MeteringAggregatorOptions) {
    this.pool = opts.pool;
    this.sink = opts.sink;
    this.eventSource = opts.eventSource;
    this.billingEnabled = opts.billingEnabled;
    this.thresholdMicros = opts.lowBalanceThresholdMicros;
    this.bucketMs = opts.bucketMs ?? DEFAULT_METERING_BUCKET_MS;
    this.settleMs = opts.settleMs ?? DEFAULT_METERING_SETTLE_MS;
    this.flushIntervalMs = opts.flushIntervalMs ?? this.bucketMs;
    this.logger = opts.logger;
    this.now = opts.now ?? (() => new Date());
  }

  /** The recorder's `onMetering` hook: accumulate a request into its time bucket. */
  ingest = (rec: MeteringRecord): void => {
    const bucketStartMs = Math.floor(rec.recordedAt.getTime() / this.bucketMs) * this.bucketMs;
    const key = `${rec.tenantId}|${bucketStartMs}`;
    let b = this.buckets.get(key);
    if (!b) {
      b = {
        tenantId: rec.tenantId,
        bucketStartMs,
        requestCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        usd: 0,
      };
      this.buckets.set(key, b);
    }
    b.requestCount += 1;
    b.inputTokens += rec.inputTokens;
    b.outputTokens += rec.outputTokens;
    b.cacheCreationInputTokens += rec.cacheCreationInputTokens;
    b.cacheReadInputTokens += rec.cacheReadInputTokens;
    b.usd += rec.usd;
  };

  /** Start the flush loop. Idempotent. */
  start(): this {
    if (this.timer) return this;
    this.timer = setInterval(() => {
      void this.flushDue().catch((err) => {
        this.logger?.warn({ err: String(err) }, "metering aggregator flush tick failed");
      });
    }, this.flushIntervalMs);
    // Do not keep the event loop alive solely for metering (tests / short-lived procs).
    this.timer.unref?.();
    return this;
  }

  /** Stop the flush loop (does not flush — call {@link flushAll} first for shutdown). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Flush every bucket that has closed + settled. Re-entrancy guarded (timer path). */
  async flushDue(): Promise<void> {
    if (this.flushing) return; // an overlapping timer fire must not stack a second flush.
    this.flushing = true;
    try {
      await this.doFlush(false);
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Flush ALL buffered buckets regardless of close/settle (graceful shutdown). NOT
   * guarded — shutdown MUST drain the buffer even if a timer tick is mid-flight;
   * idempotency (ledger UNIQUE key + export dedup) makes a concurrent flush safe.
   */
  async flushAll(): Promise<void> {
    await this.doFlush(true);
  }

  private async doFlush(all: boolean): Promise<void> {
    const nowMs = this.now().getTime();
    for (const [key, b] of [...this.buckets]) {
      const bucketEndMs = b.bucketStartMs + this.bucketMs;
      if (!all && bucketEndMs + this.settleMs > nowMs) continue; // not closed+settled.
      try {
        await this.flushBucket(b);
        this.buckets.delete(key); // only after a successful drain (export is best-effort).
      } catch (err) {
        // Keep the bucket for retry next tick (a transient drain failure). Idempotency
        // makes the re-drain safe.
        this.logger?.warn(
          { err: String(err), tenantId: b.tenantId, bucketStartMs: b.bucketStartMs },
          "metering bucket flush failed (will retry)",
        );
      }
    }
  }

  /**
   * Flush one bucket: drain the ledger (if enabled + enrolled), then emit the export
   * event. The drain is awaited and may throw (kept for retry); the export is
   * best-effort (the sink swallows its own errors).
   */
  private async flushBucket(b: BucketAccumulator): Promise<void> {
    const bucketStart = new Date(b.bucketStartMs).toISOString();
    const bucketEnd = new Date(b.bucketStartMs + this.bucketMs).toISOString();

    // 1. Drain the local ledger (§11.1 enforcement + §11.6 threshold events). Only for
    //    an enrolled tenant in a billing-enabled deployment — draining a non-enrolled
    //    tenant would enroll + start gating them, inconsistent with enforcement.
    if (this.billingEnabled) {
      const usdMicros = Math.round(b.usd * MICROS_PER_USD);
      if (usdMicros > 0) {
        const enrolled = await getBillingRow(this.pool, b.tenantId);
        if (enrolled) {
          await appendEntryWithThresholdEvents(
            this.pool,
            this.eventSource,
            {
              tenantId: b.tenantId,
              kind: "debit",
              amountMicros: -usdMicros,
              idempotencyKey: `debit:${b.tenantId}:${b.bucketStartMs}`,
              source: "usage",
              metadata: { bucketStart, bucketEnd, requestCount: b.requestCount },
            },
            this.thresholdMicros,
          );
        }
      }
    }

    // 2. Export the aggregated metering event (§11.4). Best-effort — never throws.
    const event: MeteringEvent = {
      idempotencyKey: `meter:${b.tenantId}:${b.bucketStartMs}`,
      tenantId: b.tenantId,
      bucketStart,
      bucketEnd,
      requestCount: b.requestCount,
      inputTokens: b.inputTokens,
      outputTokens: b.outputTokens,
      cacheCreationInputTokens: b.cacheCreationInputTokens,
      cacheReadInputTokens: b.cacheReadInputTokens,
      totalTokens:
        b.inputTokens + b.outputTokens + b.cacheCreationInputTokens + b.cacheReadInputTokens,
      usdCost: b.usd,
    };
    await this.sink.recordMetering(event).catch((err) => {
      this.logger?.warn(
        { err: String(err), tenantId: b.tenantId },
        "metering export delivery failed (swallowed)",
      );
    });
  }
}

/** Construct a {@link MeteringAggregator}. */
export function createMeteringAggregator(
  opts: MeteringAggregatorOptions,
): MeteringAggregator {
  return new MeteringAggregator(opts);
}
