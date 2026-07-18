/**
 * Checkout / portal URL issuance + off-session charge translation (console spec
 * §11.7).
 *
 * The SUBJECT is {@link StripeEngine}'s translation: our engine-neutral request →
 * Stripe API params → engine-neutral result. Stripe's NETWORK API is a
 * COLLABORATOR here (issuing a real hosted URL / charging a real card needs
 * Stripe's servers and credentials, which we deliberately do not hold), so it is
 * faked at the SDK seam via constructor injection — a scripted collaborator, not
 * the subject. (The security-critical webhook-signature seam is exercised for real
 * in webhook-signature.test.ts; the ledger-credit seam against the real backend in
 * webhook-ledger.integration.test.ts.)
 */

import { describe, expect, it } from "vitest";
import { StripeEngine, TENANT_METADATA_KEY, type StripeLike } from "./stripe-engine.js";

const WEBHOOK_SECRET = "whsec_test_0123456789abcdef0123456789abcdef";

/** A scripted fake of the small StripeLike surface the engine uses (collaborator). */
function fakeStripe(overrides: {
  checkoutUrl?: string | null;
  portalUrl?: string;
  charge?: { id: string; status: string } | (() => never);
}): { stripe: StripeLike; calls: { checkout: unknown[]; portal: unknown[]; charge: unknown[] } } {
  const calls = { checkout: [] as unknown[], portal: [] as unknown[], charge: [] as unknown[] };
  const stripe: StripeLike = {
    checkout: {
      sessions: {
        async create(params) {
          calls.checkout.push(params);
          // Distinguish an explicit `null` (Stripe returned no URL) from "not set".
          return {
            url:
              overrides.checkoutUrl !== undefined
                ? overrides.checkoutUrl
                : "https://checkout.stripe.test/pay/cs_123",
          };
        },
      },
    },
    billingPortal: {
      sessions: {
        async create(params) {
          calls.portal.push(params);
          return { url: overrides.portalUrl ?? "https://billing.stripe.test/portal/bps_123" };
        },
      },
    },
    paymentIntents: {
      async create(params, options) {
        calls.charge.push({ params, options });
        if (typeof overrides.charge === "function") return overrides.charge();
        return overrides.charge ?? { id: "pi_123", status: "succeeded" };
      },
    },
    webhooks: {
      constructEvent() {
        throw new Error("not used in this test");
      },
    },
  };
  return { stripe, calls };
}

describe("StripeEngine checkout / portal / charge translation", () => {
  it("createCheckoutUrl issues a hosted URL and passes the tenant + whole-cent amount", async () => {
    const { stripe, calls } = fakeStripe({ checkoutUrl: "https://checkout.stripe.test/pay/cs_abc" });
    const engine = new StripeEngine({ stripe, webhookSecret: WEBHOOK_SECRET });

    const url = await engine.createCheckoutUrl({
      tenantId: "tenant_1",
      amountMicros: 50_000_000, // $50
      successUrl: "https://console.test/billing?ok=1",
      cancelUrl: "https://console.test/billing?cancel=1",
    });

    expect(url).toBe("https://checkout.stripe.test/pay/cs_abc");
    const params = calls.checkout[0] as {
      mode: string;
      client_reference_id: string;
      metadata: Record<string, string>;
      payment_intent_data: { metadata: Record<string, string> };
      line_items: Array<{ price_data: { unit_amount: number; currency: string } }>;
    };
    expect(params.mode).toBe("payment");
    expect(params.client_reference_id).toBe("tenant_1");
    expect(params.metadata[TENANT_METADATA_KEY]).toBe("tenant_1");
    // Tenant id also on the PaymentIntent so payment_intent.succeeded carries it.
    expect(params.payment_intent_data.metadata[TENANT_METADATA_KEY]).toBe("tenant_1");
    expect(params.line_items[0].price_data.unit_amount).toBe(5000); // cents
    expect(params.line_items[0].price_data.currency).toBe("usd");
  });

  it("createCheckoutUrl throws when Stripe returns no URL (never a silent bad link)", async () => {
    const { stripe } = fakeStripe({ checkoutUrl: null });
    const engine = new StripeEngine({ stripe, webhookSecret: WEBHOOK_SECRET });
    await expect(
      engine.createCheckoutUrl({
        tenantId: "t",
        amountMicros: 10_000_000,
        successUrl: "s",
        cancelUrl: "c",
      }),
    ).rejects.toThrow(/no URL/);
  });

  it("createPortalUrl issues the hosted portal URL for the saved customer", async () => {
    const { stripe, calls } = fakeStripe({ portalUrl: "https://billing.stripe.test/p/xyz" });
    const engine = new StripeEngine({ stripe, webhookSecret: WEBHOOK_SECRET });

    const url = await engine.createPortalUrl({
      tenantId: "tenant_1",
      customerRef: "cus_1",
      returnUrl: "https://console.test/billing",
    });

    expect(url).toBe("https://billing.stripe.test/p/xyz");
    expect(calls.portal[0]).toMatchObject({ customer: "cus_1", return_url: "https://console.test/billing" });
  });

  it("chargeOffSession returns ok + paymentRef on a succeeded intent (idempotency key forwarded)", async () => {
    const { stripe, calls } = fakeStripe({ charge: { id: "pi_success", status: "succeeded" } });
    const engine = new StripeEngine({ stripe, webhookSecret: WEBHOOK_SECRET });

    const result = await engine.chargeOffSession({
      tenantId: "tenant_1",
      customerRef: "cus_1",
      paymentMethodRef: "pm_1",
      amountMicros: 50_000_000,
      idempotencyKey: "autocharge:tenant_1:123",
    });

    expect(result).toEqual({ ok: true, paymentRef: "pi_success" });
    const call = calls.charge[0] as { params: { off_session: boolean; confirm: boolean; amount: number }; options: { idempotencyKey: string } };
    expect(call.params).toMatchObject({ off_session: true, confirm: true, amount: 5000 });
    expect(call.options.idempotencyKey).toBe("autocharge:tenant_1:123");
  });

  it("chargeOffSession returns a failure code on a decline — never throws", async () => {
    const { stripe } = fakeStripe({
      charge: () => {
        const err = new Error("Your card was declined.") as Error & { code: string };
        err.code = "card_declined";
        throw err;
      },
    });
    const engine = new StripeEngine({ stripe, webhookSecret: WEBHOOK_SECRET });

    const result = await engine.chargeOffSession({
      tenantId: "tenant_1",
      customerRef: "cus_1",
      paymentMethodRef: "pm_1",
      amountMicros: 50_000_000,
      idempotencyKey: "k",
    });

    expect(result).toEqual({ ok: false, failureCode: "card_declined" });
  });

  it("chargeOffSession treats a non-succeeded status (e.g. requires_action) as a failure", async () => {
    const { stripe } = fakeStripe({ charge: { id: "pi_ra", status: "requires_action" } });
    const engine = new StripeEngine({ stripe, webhookSecret: WEBHOOK_SECRET });

    const result = await engine.chargeOffSession({
      tenantId: "tenant_1",
      customerRef: "cus_1",
      paymentMethodRef: "pm_1",
      amountMicros: 50_000_000,
      idempotencyKey: "k",
    });

    expect(result).toEqual({ ok: false, failureCode: "requires_action" });
  });
});
