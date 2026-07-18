/**
 * Checkout / portal / auto-charge WIRE SEAM (console spec §11.7–11.8, WP-C5.3 F4).
 *
 * The subject is the FULL round-trip the W15 top-up + auto-charge controls depend on:
 * the console-facing `/v1/tenant/billing/{checkout,portal,auto-charge}` routes on a
 * REAL backend (tenant-authed with a real API key) FORWARD over the machine channel
 * to a REAL adapter internal server (in-process, real HTTP). Only the Stripe SDK
 * CLIENT is faked — at the {@link StripeEngine} seam (issuing a real hosted URL needs
 * Stripe's servers + credentials we deliberately do not hold), NOT the transport. No
 * money enters the ledger here; these routes issue URLs / read-write config only.
 *
 * No provider credentials anywhere: the machine token is an obviously test-only
 * string, and the Stripe client is a scripted fake.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { StripeEngine, type StripeLike } from "../stripe-engine.js";
import { BillingAdapter } from "../adapter.js";
import { InMemoryAutoChargeStore } from "../auto-charge.js";
import { createAdapterInternalServer } from "../internal-api.js";
import type { AdapterConfig } from "../config.js";
import {
  startBackendHarness,
  integrationAvailable,
  TEST_MACHINE_TOKEN,
  type BackendHarness,
} from "./backend.js";

const WEBHOOK_SECRET = "whsec_test_0123456789abcdef0123456789abcdef";
const available = integrationAvailable("billing-adapter checkout/portal/auto-charge seam");

/** A scripted fake of the StripeLike surface: records checkout params, echoes URLs. */
function fakeStripe(): { stripe: StripeLike; checkoutParams: unknown[] } {
  const checkoutParams: unknown[] = [];
  const stripe: StripeLike = {
    checkout: {
      sessions: {
        async create(params) {
          checkoutParams.push(params);
          return { url: "https://checkout.stripe.test/pay/cs_seam" };
        },
      },
    },
    billingPortal: {
      sessions: {
        async create() {
          return { url: "https://billing.stripe.test/portal/bps_seam" };
        },
      },
    },
    paymentIntents: {
      async create() {
        throw new Error("unused in seam test");
      },
    },
    webhooks: {
      constructEvent() {
        throw new Error("unused in seam test");
      },
    },
  };
  return { stripe, checkoutParams };
}

function adapterConfig(): AdapterConfig {
  return {
    stripeSecretKey: "sk_test_seam_never_used_for_network",
    stripeWebhookSecret: WEBHOOK_SECRET,
    backendBaseUrl: "http://unused.test",
    provisionToken: TEST_MACHINE_TOKEN,
    checkoutSuccessUrl: "https://console.test/billing?ok=1",
    checkoutCancelUrl: "https://console.test/billing?cancel=1",
    portalReturnUrl: "https://console.test/billing",
    maxConsecutiveFailures: 3,
  };
}

describe.skipIf(!available)("checkout / portal / auto-charge seam (real backend ↔ real adapter)", () => {
  let harness: BackendHarness;
  let adapterServer: Server;
  let store: InMemoryAutoChargeStore;
  let checkoutParams: unknown[];
  let tenantId: string;
  let key: string;

  beforeAll(async () => {
    const fake = fakeStripe();
    checkoutParams = fake.checkoutParams;
    const engine = new StripeEngine({ stripe: fake.stripe, webhookSecret: WEBHOOK_SECRET });
    store = new InMemoryAutoChargeStore();
    const adapter = new BillingAdapter(adapterConfig(), {
      store,
      notifier: { notifyDisabled: async () => {} },
      engine,
    });
    adapterServer = createAdapterInternalServer({ adapter, store, provisionToken: TEST_MACHINE_TOKEN });
    await new Promise<void>((r) => adapterServer.listen(0, "127.0.0.1", r));
    const port = (adapterServer.address() as AddressInfo).port;

    harness = await startBackendHarness({ adapterBaseUrl: `http://127.0.0.1:${port}` });
    tenantId = await harness.freshTenant();
    key = await harness.issueTenantKey(tenantId, ["admin"]);
    // Seed a saved customer so the portal route can issue a URL (in the reference the
    // customer↔tenant map lives on the auto-charge config).
    store.setConfig(tenantId, {
      enabled: false,
      thresholdMicros: 0,
      amountMicros: 0,
      dailyCapMicros: 500_000_000,
      monthlyCapMicros: 5_000_000_000,
      customerRef: "cus_seam",
      paymentMethodRef: "pm_seam",
    });
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.close();
    if (adapterServer) await new Promise<void>((r) => adapterServer.close(() => r()));
  });

  function call(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${harness.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  it("GET auto-charge returns the config through the proxy (adapter present ⇒ 200)", async () => {
    const res = await call("GET", "/v1/tenant/billing/auto-charge");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ enabled: false, thresholdMicros: 0, amountMicros: 0 });
  });

  it("PATCH auto-charge updates (USD→micros) and the change round-trips via GET", async () => {
    const patch = await call("PATCH", "/v1/tenant/billing/auto-charge", {
      enabled: true,
      thresholdUsd: 5,
      amountUsd: 20,
    });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toMatchObject({
      enabled: true,
      thresholdMicros: 5_000_000,
      thresholdUsd: 5,
      amountMicros: 20_000_000,
      amountUsd: 20,
    });

    const get = await call("GET", "/v1/tenant/billing/auto-charge");
    expect(await get.json()).toMatchObject({ enabled: true, thresholdMicros: 5_000_000 });
  });

  it("checkout issues a hosted URL and passes the whole-cent amount to Stripe", async () => {
    const res = await call("POST", "/v1/tenant/billing/checkout", { amountUsd: 25 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://checkout.stripe.test/pay/cs_seam" });
    const params = checkoutParams.at(-1) as {
      line_items: Array<{ price_data: { unit_amount: number } }>;
      metadata: Record<string, string>;
    };
    expect(params.line_items[0].price_data.unit_amount).toBe(2500); // $25 → 2500 cents
    expect(params.metadata.tenantId).toBe(tenantId);
  });

  it("portal issues the hosted receipts / payment-method URL", async () => {
    const res = await call("POST", "/v1/tenant/billing/portal");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://billing.stripe.test/portal/bps_seam" });
  });

  it("the adapter surface rejects a tenant key presented directly (machine auth only)", async () => {
    // The tenant's real API key is NOT the machine secret — the adapter surface must
    // reject it. (The backend authenticates the tenant, then forwards the machine
    // bearer; a tenant key never reaches past the adapter's constant-time check.)
    const port = (adapterServer.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/internal/adapter/auto-charge?tenantId=${tenantId}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(401);
  });
});
