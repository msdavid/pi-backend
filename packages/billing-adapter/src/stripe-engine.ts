/**
 * Stripe reference implementation of the {@link PaymentEngine} seam (console spec
 * §11.7).
 *
 * **This is the ONLY file in the repository that imports the Stripe SDK.** All
 * Stripe-specific translation lives here: our engine-neutral requests → Stripe API
 * params → engine-neutral results. Swapping payment engines means writing a second
 * file like this one; nothing above the seam changes.
 *
 * The engine depends on a minimal {@link StripeLike} surface (the handful of Stripe
 * calls it uses) rather than the whole SDK type, so a test can inject a fake Stripe
 * client at the SDK seam (Stripe's network API is a collaborator) while
 * {@link createStripeEngine} wires the real `Stripe` instance in production. The
 * webhook-signature path uses Stripe's REAL crypto on both sides in its test — that
 * is the security-critical seam and is exercised for real.
 */

import Stripe from "stripe";
import { microsFromCents, centsFromMicros } from "./money.js";
import {
  type PaymentEngine,
  type CheckoutInput,
  type PortalInput,
  type OffSessionChargeInput,
  type ChargeResult,
  type PaymentEvent,
  WebhookVerificationError,
} from "./types.js";

/** The metadata key the tenant id is carried under on every Stripe object. */
export const TENANT_METADATA_KEY = "tenantId";

/** ISO-4217 currency the ledger transacts in (dollars, §11.1). */
const CURRENCY = "usd";

/**
 * The minimal slice of the Stripe SDK the engine uses. A real `Stripe` instance
 * satisfies it structurally; a fake in a test implements just these methods.
 */
export interface StripeLike {
  checkout: {
    sessions: {
      create(params: Stripe.Checkout.SessionCreateParams): Promise<{ url: string | null }>;
    };
  };
  billingPortal: {
    sessions: {
      create(params: Stripe.BillingPortal.SessionCreateParams): Promise<{ url: string }>;
    };
  };
  paymentIntents: {
    create(
      params: Stripe.PaymentIntentCreateParams,
      options?: Stripe.RequestOptions,
    ): Promise<{ id: string; status: string }>;
  };
  webhooks: {
    constructEvent(
      payload: string | Buffer,
      header: string,
      secret: string,
    ): { type: string; data: { object: unknown } };
  };
}

export interface StripeEngineOptions {
  stripe: StripeLike;
  /** The webhook signing secret (`whsec_…`) used to verify inbound webhooks. */
  webhookSecret: string;
}

/** Read the tenant id off a Stripe object's `metadata`, or `null` if absent. */
function tenantIdFromMetadata(obj: unknown): string | null {
  const metadata = (obj as { metadata?: Record<string, string> | null }).metadata;
  const value = metadata?.[TENANT_METADATA_KEY];
  return value && value.length > 0 ? value : null;
}

/** {@link PaymentEngine} backed by Stripe. */
export class StripeEngine implements PaymentEngine {
  private readonly stripe: StripeLike;
  private readonly webhookSecret: string;

  constructor(opts: StripeEngineOptions) {
    if (!opts.webhookSecret?.trim()) {
      // Fail-closed: without the signing secret no webhook can be verified.
      throw new Error("StripeEngine requires a non-blank webhookSecret");
    }
    this.stripe = opts.stripe;
    this.webhookSecret = opts.webhookSecret;
  }

  async createCheckoutUrl(input: CheckoutInput): Promise<string> {
    const session = await this.stripe.checkout.sessions.create({
      mode: "payment",
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.tenantId,
      // Tenant id on the session AND on the resulting PaymentIntent, so whichever
      // event we consume (session.completed / payment_intent.succeeded) carries it.
      metadata: { [TENANT_METADATA_KEY]: input.tenantId },
      payment_intent_data: { metadata: { [TENANT_METADATA_KEY]: input.tenantId } },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: CURRENCY,
            unit_amount: centsFromMicros(input.amountMicros),
            product_data: { name: "Account balance top-up" },
          },
        },
      ],
    });
    if (!session.url) {
      throw new Error("Stripe checkout session has no URL");
    }
    return session.url;
  }

  async createPortalUrl(input: PortalInput): Promise<string> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: input.customerRef,
      return_url: input.returnUrl,
    });
    return session.url;
  }

  verifyWebhook(rawBody: string | Buffer, signatureHeader: string): PaymentEvent {
    let event: { type: string; data: { object: unknown } };
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signatureHeader, this.webhookSecret);
    } catch (err) {
      // constructEvent throws on a bad/absent signature, wrong secret, or a stale
      // timestamp outside the tolerance. Every one of those is untrusted input.
      throw new WebhookVerificationError(
        `webhook signature verification failed: ${(err as Error).message}`,
      );
    }
    return normalizeEvent(event);
  }

  async chargeOffSession(input: OffSessionChargeInput): Promise<ChargeResult> {
    try {
      const intent = await this.stripe.paymentIntents.create(
        {
          amount: centsFromMicros(input.amountMicros),
          currency: CURRENCY,
          customer: input.customerRef,
          payment_method: input.paymentMethodRef,
          off_session: true,
          confirm: true,
          metadata: { [TENANT_METADATA_KEY]: input.tenantId },
        },
        { idempotencyKey: input.idempotencyKey },
      );
      if (intent.status === "succeeded") {
        return { ok: true, paymentRef: intent.id };
      }
      // Off-session intents that need further action (e.g. 3DS) can't complete
      // unattended — treat as a failure so the failure counter advances (no retry).
      return { ok: false, failureCode: intent.status };
    } catch (err) {
      // A decline surfaces as a StripeCardError with a stable `.code`. Never throw
      // from an auto-charge — the engine reports the failure and the caller counts it.
      const code = (err as { code?: string }).code;
      return { ok: false, failureCode: code ?? "charge_error" };
    }
  }
}

/** Normalize a verified Stripe event to the engine-neutral {@link PaymentEvent}. */
function normalizeEvent(event: { type: string; data: { object: unknown } }): PaymentEvent {
  const obj = event.data.object;
  if (event.type === "checkout.session.completed") {
    const session = obj as {
      id: string;
      payment_status?: string;
      amount_total?: number | null;
      payment_intent?: string | null;
    };
    // Prefer the PaymentIntent id as the stable payment ref, so a checkout and its
    // payment_intent.succeeded event resolve to the SAME ledger idempotency key.
    const paymentRef =
      typeof session.payment_intent === "string" ? session.payment_intent : session.id;
    return {
      isPaymentSucceeded: session.payment_status === "paid",
      tenantId: tenantIdFromMetadata(obj),
      amountMicros: microsFromCents(session.amount_total ?? 0),
      paymentRef,
      engineEventType: event.type,
    };
  }
  if (event.type === "payment_intent.succeeded") {
    const intent = obj as { id: string; amount?: number | null };
    return {
      isPaymentSucceeded: true,
      tenantId: tenantIdFromMetadata(obj),
      amountMicros: microsFromCents(intent.amount ?? 0),
      paymentRef: intent.id,
      engineEventType: event.type,
    };
  }
  // Any other event type is verified-but-ignored (not a top-up).
  const id = (obj as { id?: string }).id ?? "unknown";
  return {
    isPaymentSucceeded: false,
    tenantId: null,
    amountMicros: 0,
    paymentRef: id,
    engineEventType: event.type,
  };
}

/**
 * Build a {@link StripeEngine} wiring a real `Stripe` client from the secret key.
 * The `as unknown as StripeLike` cast is the single boundary where the SDK's exact
 * types meet our narrowed surface; it lives here at the composition edge only.
 */
export function createStripeEngine(opts: {
  secretKey: string;
  webhookSecret: string;
}): StripeEngine {
  const stripe = new Stripe(opts.secretKey) as unknown as StripeLike;
  return new StripeEngine({ stripe, webhookSecret: opts.webhookSecret });
}
