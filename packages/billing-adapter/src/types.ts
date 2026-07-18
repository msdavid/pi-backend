/**
 * The payment-engine-agnostic seam (console spec §11.7, WP-C5.3).
 *
 * `PaymentEngine` is the whole contract the rest of the adapter (and the backend)
 * programs against; Stripe is one implementation ({@link ./stripe-engine.ts}). A
 * different engine (Paddle, a merchant-of-record, …) is a drop-in second impl of
 * this interface — **the payment SDK lives ONLY behind it.** Everything above the
 * seam (webhook consumer, auto-charge engine, ledger client) is engine-neutral.
 *
 * `LedgerClient` is the narrow machine-credential provisioning surface the adapter
 * uses to credit the backend ledger (host-agent bearer, NOT a tenant key). It is
 * the SOLE way money enters the ledger from a payment.
 */

// --- Payment engine seam ----------------------------------------------------

/** Input to {@link PaymentEngine.createCheckoutUrl}. `amountMicros` is the top-up. */
export interface CheckoutInput {
  tenantId: string;
  amountMicros: number;
  /** Where the hosted page returns on success / cancel (the console's return routes). */
  successUrl: string;
  cancelUrl: string;
}

/** Input to {@link PaymentEngine.createPortalUrl}. */
export interface PortalInput {
  tenantId: string;
  /** The engine's opaque customer handle (adapter-internal; NOT a card or a secret). */
  customerRef: string;
  returnUrl: string;
}

/** Input to {@link PaymentEngine.chargeOffSession} (auto-charge). */
export interface OffSessionChargeInput {
  tenantId: string;
  /** The engine's saved-customer handle. */
  customerRef: string;
  /** The engine's saved-payment-method handle (adapter-internal; never a card number). */
  paymentMethodRef: string;
  amountMicros: number;
  /**
   * Idempotency key passed THROUGH to the engine so a retried API call does not
   * double-charge the card (distinct from the ledger idempotency key, which is
   * derived from the resulting payment id).
   */
  idempotencyKey: string;
}

/** Outcome of an off-session charge. `ok:false` carries a stable failure code. */
export interface ChargeResult {
  ok: boolean;
  /** Stable id of the resulting payment (present when `ok`); the ledger key derives from it. */
  paymentRef?: string;
  /** Engine-stable decline/error code when `!ok` (e.g. `card_declined`). Never a secret. */
  failureCode?: string;
}

/**
 * A payment webhook, verified and normalized to engine-neutral fields. Produced
 * by {@link PaymentEngine.verifyWebhook} (which throws on a bad signature — the
 * event is trusted ONLY after verification).
 */
export interface PaymentEvent {
  /** True for a completed top-up payment (the only event that credits the ledger). */
  isPaymentSucceeded: boolean;
  /** The tenant to credit, read from the payment's metadata (`null` if absent/foreign). */
  tenantId: string | null;
  /** The paid amount in micro-dollars. */
  amountMicros: number;
  /** Stable id of the underlying payment — the ledger idempotency key derives from it. */
  paymentRef: string;
  /** The engine's own event type string, for logging (e.g. `checkout.session.completed`). */
  engineEventType: string;
}

/** Thrown by {@link PaymentEngine.verifyWebhook} when signature verification fails. */
export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

/**
 * The payment-engine-agnostic seam. The Stripe SDK is imported behind exactly one
 * implementation of this interface; nothing else in the repo may import it (§11.7).
 */
export interface PaymentEngine {
  /** Create a hosted checkout page for a one-time top-up; returns its URL. */
  createCheckoutUrl(input: CheckoutInput): Promise<string>;
  /** Create a hosted customer/billing portal page; returns its URL. */
  createPortalUrl(input: PortalInput): Promise<string>;
  /**
   * Verify a raw webhook body against its signature header and normalize it.
   * MUST throw {@link WebhookVerificationError} on any verification failure
   * (bad signature, wrong secret, stale/absent timestamp) — the caller trusts
   * the returned event only because this verified it.
   */
  verifyWebhook(rawBody: string | Buffer, signatureHeader: string): PaymentEvent;
  /** Charge a saved payment method off-session (auto-charge). Never throws for a decline. */
  chargeOffSession(input: OffSessionChargeInput): Promise<ChargeResult>;
}

// --- Ledger client seam (machine credit-surface, §11.7) ---------------------

/** Input to {@link LedgerClient.credit}. Amount is positive integer micro-dollars. */
export interface LedgerCreditInput {
  tenantId: string;
  amountMicros: number;
  /** Per-tenant idempotency key — a replay credits EXACTLY once (the money invariant). */
  idempotencyKey: string;
  /** Provenance recorded on the ledger entry (`stripe`, `stripe-autocharge`). Never a secret. */
  source?: string;
  metadata?: Record<string, unknown>;
}

/** Result of a ledger credit (mirrors `POST /internal/billing/credit`). */
export interface LedgerCreditResult {
  entryId: string;
  /** `false` on an idempotent replay (the key already existed; balance untouched). */
  applied: boolean;
  balanceMicros: number;
}

/**
 * The machine credit-surface client — the ONLY path money reaches the ledger from
 * a payment. Authenticates with the host-agent bearer secret (`BILLING_PROVISION_
 * TOKEN`), NOT a tenant API key. Idempotency is the backend ledger's UNIQUE key.
 */
export interface LedgerClient {
  credit(input: LedgerCreditInput): Promise<LedgerCreditResult>;
}
