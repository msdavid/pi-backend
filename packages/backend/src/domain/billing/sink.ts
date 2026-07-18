/**
 * Billing sink interface (WP-5.3 / WP-C5.2, §29.6, console spec §11.4).
 *
 * A pluggable sink for **metering export events** — the usage→billing seam. The
 * metering aggregator (`metering.ts`) sums a tenant's usage over a fixed
 * wall-clock bucket and emits ONE aggregated {@link MeteringEvent} to the
 * configured {@link BillingSink} (§11.4: time-bucketed, never per-turn). The
 * composition root (app.ts) wires the chosen impl: the no-op sink (default,
 * self-hosted / billing disabled) or the webhook-emitting sink (SaaS, posts to an
 * operator-configured billing endpoint).
 *
 * This mirrors the {@link WebhookSink} plugin shape (§23, ports.ts): a single
 * `record*` method the producer calls without depending on the delivery impl.
 * Additional sinks (e.g. `stripe`) are additive implementations of the same seam.
 *
 * No new deps.
 */

// The wire shape is the published contract (console spec §11.4) — a single source
// so a sink consumer validates each delivery against exactly what we emit.
export type { MeteringEvent } from "@pi-managed/contracts";
import type { MeteringEvent } from "@pi-managed/contracts";

/**
 * Pluggable billing sink (§29.6, §11.4). Implementations:
 * - {@link NoopBillingSink} — default; discards events (billing disabled).
 * - {@link WebhookBillingSink} — posts signed metering events to a billing
 *   webhook endpoint (HTTPS, HMAC-signed like the webhook dispatcher, §23.4).
 *
 * `recordMetering` is at-least-once: implementations MUST be safe to call
 * repeatedly for the same logical event (recipients dedup on the event's
 * `idempotencyKey`). It MUST NOT throw — metering is best-effort and must never
 * block usage recording (§29.6).
 */
export interface BillingSink {
  recordMetering(event: MeteringEvent): Promise<void>;
}
