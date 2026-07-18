/**
 * Payment-webhook consumer (console spec §11.7, WP-C5.3).
 *
 * Receives a raw webhook body + signature header, VERIFIES it through the engine
 * (untrusted until verified), and — for a completed top-up — credits the tenant's
 * ledger through the machine credit-surface. The ledger idempotency key is derived
 * from the payment id ({@link creditKeyForPayment}), so a Stripe re-delivery of the
 * same payment credits EXACTLY once (§13) — the ledger's UNIQUE key is the gate.
 *
 * `handleWebhook` re-throws a {@link WebhookVerificationError} so the HTTP receiver
 * can answer 400 (Stripe then retries later); a verified event that isn't a top-up
 * returns `credited:false` (the receiver answers 200 — nothing to do).
 */

import { creditKeyForPayment } from "./credit-key.js";
import type { LedgerClient, PaymentEngine } from "./types.js";

/** Outcome of processing one webhook delivery. */
export interface HandleWebhookResult {
  /** True when the event was a top-up that was forwarded to the ledger. */
  credited: boolean;
  /** For a credited event: `false` when the ledger deduped a replay (money invariant). */
  applied?: boolean;
  entryId?: string;
  /** Why a verified event was not credited (`ignored_event_type` | `no_tenant`). */
  reason?: "ignored_event_type" | "no_tenant";
  /** The engine's event type, for the receiver's logging. */
  engineEventType: string;
}

export interface WebhookConsumerDeps {
  engine: PaymentEngine;
  ledger: LedgerClient;
}

/**
 * Verify and process one payment webhook. Throws {@link WebhookVerificationError}
 * (from the engine) on an unverifiable signature — the caller MUST NOT credit on a
 * throw.
 */
export async function handleWebhook(
  deps: WebhookConsumerDeps,
  rawBody: string | Buffer,
  signatureHeader: string,
): Promise<HandleWebhookResult> {
  const event = deps.engine.verifyWebhook(rawBody, signatureHeader);

  if (!event.isPaymentSucceeded) {
    return { credited: false, reason: "ignored_event_type", engineEventType: event.engineEventType };
  }
  if (!event.tenantId) {
    // A paid event with no tenant metadata can't be attributed — never guess.
    return { credited: false, reason: "no_tenant", engineEventType: event.engineEventType };
  }

  const result = await deps.ledger.credit({
    tenantId: event.tenantId,
    amountMicros: event.amountMicros,
    idempotencyKey: creditKeyForPayment(event.paymentRef),
    source: "stripe",
    metadata: { paymentRef: event.paymentRef, engineEventType: event.engineEventType },
  });
  return {
    credited: true,
    applied: result.applied,
    entryId: result.entryId,
    engineEventType: event.engineEventType,
  };
}
