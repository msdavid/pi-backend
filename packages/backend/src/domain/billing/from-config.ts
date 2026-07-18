/**
 * Config → {@link BillingSink} construction (W8.2, §29.6).
 *
 * The composition root (`app.ts`) calls {@link createBillingSink} and hands the
 * result to the `MeteringAggregator`, whose flush loop posts the aggregated,
 * time-bucketed events to this sink (§11.4).
 *
 * Selection is `config.billingSink`:
 * - `none` (default) → {@link NOOP_BILLING_SINK}. Existing behavior, unchanged:
 *   the aggregator is not wired at all (billing disabled) — no events, no egress.
 * - `webhook` → {@link WebhookBillingSink} against `billingWebhookUrl`, signed with
 *   `billingWebhookSecret`. Both are required; a missing one is a **boot error**
 *   (a billing sink that silently drops revenue events is worse than no boot).
 *
 * Mirrors `objectStoreFromConfig` (infra/objectstore) — the same "validated Config
 * in, real impl out" shape, so subsystems never read `process.env`.
 */

import type { Logger } from "pino";
import type { Config } from "../../infra/config/index.js";
import type { PinnedDnsResolver } from "../net/ssrf-pin.js";
import type { BillingSink } from "./sink.js";
import { NOOP_BILLING_SINK } from "./noop-sink.js";
import { WebhookBillingSink } from "./webhook-sink.js";

/**
 * Test-only injection points for the webhook sink (fetch/DNS/backoff), mirroring
 * `webhookDispatcherOptions` on the composition root. Ignored when the configured
 * sink is `none`.
 */
export interface BillingSinkOverrides {
  fetchImpl?: typeof fetch;
  dnsResolver?: PinnedDnsResolver;
  maxAttempts?: number;
  backoff?: (attempt: number) => number;
  now?: () => Date;
}

/** Build the configured billing sink. Defaults to the no-op sink (billing disabled). */
export function createBillingSink(
  config: Config,
  logger?: Logger,
  overrides: BillingSinkOverrides = {},
): BillingSink {
  if (config.billingSink !== "webhook") return NOOP_BILLING_SINK;

  const endpoint = config.billingWebhookUrl;
  const signingSecret = config.billingWebhookSecret;
  if (!endpoint || !signingSecret) {
    throw new Error(
      "BILLING_SINK=webhook requires BILLING_WEBHOOK_URL (https) and BILLING_WEBHOOK_SECRET — " +
        "refusing to boot with a billing sink that would drop every metering event.",
    );
  }

  return new WebhookBillingSink({
    endpoint,
    signingSecret,
    ...(logger ? { logger } : {}),
    ...overrides,
  });
}
