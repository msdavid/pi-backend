/**
 * No-op billing sink (WP-5.3, §29.6) — the default.
 *
 * Discards every metering event. Used when billing is disabled (self-hosted
 * deployments, or SaaS before a billing endpoint is configured). The
 * composition root falls back to this when no billing sink is wired.
 *
 * No new deps.
 */

import type { BillingSink, MeteringEvent } from "./sink.js";

/** Default no-op sink; does nothing. Safe to share (stateless). */
export class NoopBillingSink implements BillingSink {
  async recordMetering(_event: MeteringEvent): Promise<void> {
    // intentionally no-op (§29.6)
  }
}

/** Shared singleton instance (stateless — safe to reuse). */
export const NOOP_BILLING_SINK: BillingSink = new NoopBillingSink();
