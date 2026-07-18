/**
 * The single derivation of a ledger idempotency key from a payment id (§11.7,
 * §13).
 *
 * Both entry points that credit the ledger — the webhook consumer (a Stripe
 * re-delivery of the SAME payment) and the auto-charge engine (whose off-session
 * charge ALSO triggers a webhook for the same payment) — derive their ledger key
 * from the payment's stable id through THIS function. Because the key is identical
 * across all of those paths, the ledger's `UNIQUE (tenant_id, idempotency_key)`
 * constraint credits the payment EXACTLY once no matter how many times, or through
 * which path, it is presented. Changing this derivation is a money-correctness
 * change, not a refactor.
 */

/** Ledger idempotency key for a payment. Stable per payment id, prefixed `stripe:`. */
export function creditKeyForPayment(paymentRef: string): string {
  return `stripe:${paymentRef}`;
}
