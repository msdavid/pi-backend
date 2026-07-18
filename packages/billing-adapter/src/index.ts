/**
 * `@pi-managed/billing-adapter` — the payment-engine adapter (Stripe reference)
 * for the prepaid ledger (console spec §11.7, WP-C5.3).
 *
 * **The Stripe SDK is imported in exactly one file here ({@link ./stripe-engine.ts})
 * and appears in no other package.** Everything else is engine-neutral: the
 * {@link PaymentEngine} seam, the machine credit-surface client, the webhook
 * consumer, and the auto-charge engine. See `README.md` for deployment/config.
 */

export const BILLING_ADAPTER_VERSION = "0.0.0";

// Config (fail-closed env loading).
export {
  loadAdapterConfig,
  AdapterConfigError,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  type AdapterConfig,
  type EnvLike,
} from "./config.js";

// The engine-agnostic seam + shared types.
export {
  WebhookVerificationError,
  type PaymentEngine,
  type CheckoutInput,
  type PortalInput,
  type OffSessionChargeInput,
  type ChargeResult,
  type PaymentEvent,
  type LedgerClient,
  type LedgerCreditInput,
  type LedgerCreditResult,
} from "./types.js";

// Money conversion (ledger µUSD ↔ engine cents / console USD).
export {
  centsFromMicros,
  microsFromCents,
  microsFromUsd,
  usdFromMicros,
  MICROS_PER_CENT,
  MICROS_PER_USD,
  MoneyConversionError,
} from "./money.js";

// Shared ledger idempotency-key derivation (the money invariant).
export { creditKeyForPayment } from "./credit-key.js";

// Stripe reference engine (the only SDK holder).
export { StripeEngine, createStripeEngine, TENANT_METADATA_KEY, type StripeLike, type StripeEngineOptions } from "./stripe-engine.js";

// Machine credit-surface client.
export { HttpLedgerClient, CREDIT_PATH, LedgerCreditError, type HttpLedgerClientOptions, type FetchLike } from "./ledger-client.js";

// Payment-webhook consumer.
export { handleWebhook, type HandleWebhookResult, type WebhookConsumerDeps } from "./webhook-consumer.js";

// Auto-charge engine + its seams.
export {
  AutoChargeEngine,
  InMemoryAutoChargeStore,
  type AutoChargeConfig,
  type AutoChargeConfigPatch,
  type AutoChargeStore,
  type AutoChargeNotifier,
  type AutoChargeResult,
  type AutoChargeOutcome,
  type AutoChargeEngineDeps,
} from "./auto-charge.js";

// Adapter internal HTTP surface (the backend's SDK-free proxy calls this).
export {
  createAdapterInternalHandler,
  createAdapterInternalServer,
  ADAPTER_CHECKOUT_PATH,
  ADAPTER_PORTAL_PATH,
  ADAPTER_AUTO_CHARGE_PATH,
  type AdapterInternalDeps,
  type AdapterInternalLogger,
  type AdapterUrlIssuer,
} from "./internal-api.js";

// Composition root.
export { BillingAdapter, type BillingAdapterDeps } from "./adapter.js";
