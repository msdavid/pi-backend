/**
 * Webhook signature verification — the SECURITY-CRITICAL seam (console spec §11.7).
 *
 * Both sides are REAL Stripe crypto and the test is hermetic (pure HMAC, no
 * network): a payload is signed with Stripe's own scheme via
 * `stripe.webhooks.generateTestHeaderString`, and the adapter verifies it through
 * `StripeEngine.verifyWebhook` (Stripe's `constructEvent`). We assert it ACCEPTS a
 * valid signature and REJECTS a tampered body, the wrong secret, and a stale
 * timestamp.
 *
 * The signing secret is generated LOCALLY and is obviously test-only (`whsec_test_…`)
 * — it is NOT a provider credential (CONVENTIONS). The `sk_test_…` handed to the
 * Stripe constructor is likewise a dummy: `constructEvent` is pure crypto and never
 * uses it for network.
 */

import { describe, expect, it } from "vitest";
import Stripe from "stripe";
import { createStripeEngine } from "./stripe-engine.js";
import { WebhookVerificationError } from "./types.js";

// Locally-generated, obviously test-only. Not a real credential.
const WEBHOOK_SECRET = "whsec_test_" + "0123456789abcdef0123456789abcdef";
const OTHER_SECRET = "whsec_test_" + "ffffffffffffffffffffffffffffffff";
const DUMMY_SK = "sk_test_dummy_key_never_used_for_network";

/** A minimal, valid checkout.session.completed event body. */
function paidCheckoutPayload(tenantId: string): string {
  return JSON.stringify({
    id: "evt_test_1",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_1",
        object: "checkout.session",
        payment_status: "paid",
        amount_total: 5000, // $50.00 in cents
        payment_intent: "pi_test_1",
        metadata: { tenantId },
      },
    },
  });
}

/** A standalone real Stripe client used only to SIGN in these tests. */
const signer = new Stripe(DUMMY_SK);

function sign(payload: string, secret: string, timestampSec?: number): string {
  return signer.webhooks.generateTestHeaderString({
    payload,
    secret,
    ...(timestampSec !== undefined ? { timestamp: timestampSec } : {}),
  });
}

describe("StripeEngine.verifyWebhook (real Stripe crypto, hermetic)", () => {
  const engine = createStripeEngine({ secretKey: DUMMY_SK, webhookSecret: WEBHOOK_SECRET });

  it("ACCEPTS a validly-signed payload and normalizes it", () => {
    const payload = paidCheckoutPayload("tenant_abc");
    const header = sign(payload, WEBHOOK_SECRET);

    const event = engine.verifyWebhook(payload, header);

    expect(event.isPaymentSucceeded).toBe(true);
    expect(event.tenantId).toBe("tenant_abc");
    expect(event.amountMicros).toBe(50_000_000); // 5000 cents → µUSD
    expect(event.paymentRef).toBe("pi_test_1"); // the PaymentIntent id
    expect(event.engineEventType).toBe("checkout.session.completed");
  });

  it("REJECTS a tampered body (signature no longer matches)", () => {
    const payload = paidCheckoutPayload("tenant_abc");
    const header = sign(payload, WEBHOOK_SECRET);
    const tampered = payload.replace("5000", "500000"); // attacker inflates the amount

    expect(() => engine.verifyWebhook(tampered, header)).toThrow(WebhookVerificationError);
  });

  it("REJECTS a payload signed with the WRONG secret", () => {
    const payload = paidCheckoutPayload("tenant_abc");
    const header = sign(payload, OTHER_SECRET);

    expect(() => engine.verifyWebhook(payload, header)).toThrow(WebhookVerificationError);
  });

  it("REJECTS a stale timestamp (outside Stripe's tolerance)", () => {
    const payload = paidCheckoutPayload("tenant_abc");
    const staleTs = Math.floor(Date.now() / 1000) - 10_000; // ~2.7 h old
    const header = sign(payload, WEBHOOK_SECRET, staleTs);

    expect(() => engine.verifyWebhook(payload, header)).toThrow(WebhookVerificationError);
  });

  it("REJECTS an absent/garbage signature header", () => {
    const payload = paidCheckoutPayload("tenant_abc");
    expect(() => engine.verifyWebhook(payload, "not-a-signature")).toThrow(WebhookVerificationError);
  });
});
