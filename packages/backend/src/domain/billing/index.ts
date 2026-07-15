/**
 * Billing subsystem barrel (WP-5.3, §29.6).
 *
 * The usage→billing metering seam: a pluggable {@link BillingSink} (no-op
 * default + webhook-emitting impl) wired to the usage recorder via the
 * metering hook. No processor integration (requires explicit human direction).
 */

export { type MeteringEvent, type BillingSink } from "./sink.js";
export { NoopBillingSink, NOOP_BILLING_SINK } from "./noop-sink.js";
export {
  WebhookBillingSink,
  BillingSsrfError,
  defaultBillingBackoff,
  DEFAULT_BILLING_MAX_ATTEMPTS,
  type WebhookBillingSinkOptions,
} from "./webhook-sink.js";
export {
  createBillingSink,
  type BillingSinkOverrides,
} from "./from-config.js";
export {
  createMeteringHook,
  type MeteringRecord,
  type MeteringHook,
} from "./metering.js";
