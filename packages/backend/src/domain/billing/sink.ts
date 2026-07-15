/**
 * Billing sink interface (WP-5.3, §29.6).
 *
 * A pluggable sink for **metering events** — the usage→billing seam. After each
 * successful `UsageRecorder.record()` (§9.7), a {@link MeteringEvent} is emitted
 * to the configured {@link BillingSink}. The composition root (server.ts/app.ts)
 * wires the chosen impl: the no-op sink (default, self-hosted / billing disabled)
 * or the webhook-emitting sink (SaaS, posts to an operator-configured billing
 * endpoint).
 *
 * This mirrors the {@link WebhookSink} plugin shape (§23, ports.ts): a single
 * `record*` method the producer calls without depending on the delivery impl.
 * No processor integration here — only the hook + the two reference impls; a
 * processor integration requires explicit human direction (§29.6).
 *
 * No new deps.
 */

import type { SessionId, TenantId } from "../ports.js";

/**
 * A single metering event: one model request's billable usage, attributed to a
 * tenant + session, with the USD cost derived from the per-model price table
 * (§9.7). `recordedAt` is ISO-8601 UTC (matches the `usage_records.recorded_at`
 * column the recorder just wrote, §3.13).
 */
export interface MeteringEvent {
  tenantId: TenantId;
  sessionId: SessionId;
  /** Model identifier as the provider reports it (§9.7). */
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** USD cost via the per-model price table (§9.7), rounded to `numeric(12,6)`. */
  usdCost: number;
  /** ISO-8601 timestamp of the underlying `record()` call. */
  recordedAt: string;
}

/**
 * Pluggable billing sink (§29.6). Implementations:
 * - {@link NoopBillingSink} — default; discards events (billing disabled).
 * - {@link WebhookBillingSink} — posts signed metering events to a billing
 *   webhook endpoint (HTTPS, HMAC-signed like the webhook dispatcher, §23.4).
 *
 * `recordMetering` is at-least-once: implementations MUST be safe to call
 * repeatedly for the same logical event (recipients dedup on `recordedAt` /
 * the delivery id header). It MUST NOT throw — metering is best-effort and
 * must never block usage recording (§29.6).
 */
export interface BillingSink {
  recordMetering(event: MeteringEvent): Promise<void>;
}
