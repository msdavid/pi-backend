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
  MeteringAggregator,
  createMeteringAggregator,
  DEFAULT_METERING_SETTLE_MS,
  type MeteringRecord,
  type MeteringHook,
  type MeteringAggregatorOptions,
} from "./metering.js";
export {
  appendEntryWithThresholdEvents,
  emitBalanceThresholdEvents,
  detectBalanceCrossings,
  type BalanceCrossings,
} from "./threshold.js";
// WP-C5.1: the ledger (source of truth for balance), tenant lifecycle, trial
// verification, and fail-soft suspension enforcement (console spec §11.1/§11.3).
export {
  appendEntry,
  ensureBillingRow,
  getBillingRow,
  getBillingState,
  listLedgerEntries,
  microsToUsd,
  LedgerAmountError,
  type AppendEntryInput,
  type AppendEntryResult,
  type TenantBillingRow,
  type LedgerCursor,
} from "./ledger.js";
export { assertCanStartWork } from "./enforcement.js";
export {
  provisionTrial,
  resendVerification,
  verifyEmail,
  emailForTenant,
  TRIAL_GRANT_MICROS,
  VERIFICATION_TTL_MS,
  VERIFICATION_EMAIL_TEMPLATE,
} from "./trial.js";
