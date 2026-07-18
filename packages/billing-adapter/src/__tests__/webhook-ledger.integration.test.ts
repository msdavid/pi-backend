/**
 * THE core money test (console spec §11.7 / §13): a replayed payment webhook
 * credits the ledger EXACTLY once.
 *
 * Fully real, both sides of the seam (CONVENTIONS: fakes at the seam):
 * - real Stripe crypto verifies the webhook signature ({@link StripeEngine}),
 * - the real {@link HttpLedgerClient} POSTs over real HTTP to
 * - the real backend machine credit-surface on a LISTENING Fastify app +
 *   testcontainers Postgres.
 *
 * The signing secret + machine token are generated locally and are obviously
 * test-only — NOT provider credentials.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { createStripeEngine } from "../stripe-engine.js";
import { HttpLedgerClient } from "../ledger-client.js";
import { handleWebhook } from "../webhook-consumer.js";
import { startBackendHarness, integrationAvailable, type BackendHarness } from "./backend.js";

const WEBHOOK_SECRET = "whsec_test_0123456789abcdef0123456789abcdef";
const DUMMY_SK = "sk_test_dummy_key_never_used_for_network";
const signer = new Stripe(DUMMY_SK);

const available = integrationAvailable("billing-adapter webhook↔ledger integration");

function paidCheckout(tenantId: string, paymentIntentId: string, amountCents: number): string {
  return JSON.stringify({
    id: `evt_${paymentIntentId}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_${paymentIntentId}`,
        payment_status: "paid",
        amount_total: amountCents,
        payment_intent: paymentIntentId,
        metadata: { tenantId },
      },
    },
  });
}

describe.skipIf(!available)("payment webhook → ledger credit (real backend)", () => {
  let harness: BackendHarness;

  beforeAll(async () => {
    harness = await startBackendHarness();
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.close();
  });

  function adapter() {
    const engine = createStripeEngine({ secretKey: DUMMY_SK, webhookSecret: WEBHOOK_SECRET });
    const ledger = new HttpLedgerClient({
      baseUrl: harness.baseUrl,
      provisionToken: harness.provisionToken,
    });
    return { engine, ledger };
  }

  it("credits the ledger once, and a REPLAY of the same event credits exactly once", async () => {
    const tenantId = await harness.freshTenant();
    const payload = paidCheckout(tenantId, "pi_replay_1", 5000); // $50
    const header = signer.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
    const deps = adapter();

    const first = await handleWebhook(deps, payload, header);
    expect(first.credited).toBe(true);
    expect(first.applied).toBe(true);

    // Stripe re-delivers the SAME event (at-least-once). Drive it again.
    const replay = await handleWebhook(deps, payload, header);
    expect(replay.credited).toBe(true);
    expect(replay.applied).toBe(false); // ledger deduped on the derived key

    expect(await harness.countTopups(tenantId)).toBe(1);
    expect(await harness.balanceMicros(tenantId)).toBe(50_000_000);
  });

  it("rejects a tampered body against the real backend (no credit)", async () => {
    const tenantId = await harness.freshTenant();
    const payload = paidCheckout(tenantId, "pi_tamper_1", 5000);
    const header = signer.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
    const deps = adapter();

    const tampered = payload.replace("5000", "9999999");
    await expect(handleWebhook(deps, tampered, header)).rejects.toThrow();
    expect(await harness.countTopups(tenantId)).toBe(0);
  });

  it("a verified NON-payment event does not credit", async () => {
    const tenantId = await harness.freshTenant();
    const payload = JSON.stringify({
      id: "evt_ping",
      type: "ping",
      data: { object: { id: "obj_ping", metadata: { tenantId } } },
    });
    const header = signer.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });

    const result = await handleWebhook(adapter(), payload, header);
    expect(result.credited).toBe(false);
    expect(result.reason).toBe("ignored_event_type");
    expect(await harness.countTopups(tenantId)).toBe(0);
  });
});
