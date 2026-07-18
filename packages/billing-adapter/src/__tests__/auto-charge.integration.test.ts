/**
 * Auto-charge engine (console spec §11.7) against the REAL ledger.
 *
 * Proves the non-negotiable safety rails and the money invariant:
 * - a daily cap and a monthly cap are NEVER exceeded, and the ROLLING WINDOW is
 *   exercised with a MOVING clock (a charge just inside the window still counts;
 *   one just outside no longer does) — WP-C5.3 F3,
 * - a redelivered `tenant.balance_low` for the SAME crossing charges the card ONCE
 *   and credits the ledger ONCE (idempotency keyed on the stable crossing id) —
 *   WP-C5.3 F1,
 * - two concurrent crossings for one tenant are serialized so the cap is never
 *   raced past — WP-C5.3 F2,
 * - N consecutive failures auto-disable auto-charge AND notify the user (no silent
 *   retries),
 * - a successful auto-charge credits the ledger like any top-up, and the SAME
 *   payment arriving later as a webhook does NOT double-credit (shared idempotency
 *   key).
 *
 * The ledger is REAL (listening backend + testcontainers Postgres). Stripe's charge
 * API is a COLLABORATOR — faked at the engine seam via constructor injection (a
 * scripted collaborator, not the subject). No provider credentials anywhere.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import type { TenantBalanceEventData } from "@pi-managed/contracts";
import { AutoChargeEngine, InMemoryAutoChargeStore, type AutoChargeConfig } from "../auto-charge.js";
import { HttpLedgerClient } from "../ledger-client.js";
import { createStripeEngine } from "../stripe-engine.js";
import { handleWebhook } from "../webhook-consumer.js";
import type { ChargeResult, OffSessionChargeInput, PaymentEngine } from "../types.js";
import { startBackendHarness, integrationAvailable, type BackendHarness } from "./backend.js";

const WEBHOOK_SECRET = "whsec_test_0123456789abcdef0123456789abcdef";
const DUMMY_SK = "sk_test_dummy_key_never_used_for_network";
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * DAY_MS;

const available = integrationAvailable("billing-adapter auto-charge integration");

/** A scripted fake PaymentEngine — only `chargeOffSession` is exercised here. */
function fakeEngine(charge: (n: number) => Promise<ChargeResult>): PaymentEngine {
  let n = 0;
  return {
    createCheckoutUrl: async () => {
      throw new Error("unused");
    },
    createPortalUrl: async () => {
      throw new Error("unused");
    },
    verifyWebhook: () => {
      throw new Error("unused");
    },
    chargeOffSession: async () => charge(++n),
  };
}

/**
 * A fake engine that HONORS the idempotency key like a real payment engine: a repeat
 * key returns the SAME payment without a second real charge. `state.charges` counts
 * the real (distinct-key) charges. `delayMs` yields inside the charge so a
 * non-serialized caller can interleave (the F2 race). This is the collaborator that
 * makes F1 (one charge on redelivery) and F2 (no cap race) observable.
 */
function idempotentEngine(opts: { delayMs?: number } = {}): {
  engine: PaymentEngine;
  state: { charges: number };
} {
  const seen = new Map<string, string>();
  const state = { charges: 0 };
  const engine: PaymentEngine = {
    createCheckoutUrl: async () => {
      throw new Error("unused");
    },
    createPortalUrl: async () => {
      throw new Error("unused");
    },
    verifyWebhook: () => {
      throw new Error("unused");
    },
    chargeOffSession: async (input: OffSessionChargeInput): Promise<ChargeResult> => {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const existing = seen.get(input.idempotencyKey);
      if (existing) return { ok: true, paymentRef: existing };
      state.charges += 1;
      const ref = `pi_auto_${state.charges}`;
      seen.set(input.idempotencyKey, ref);
      return { ok: true, paymentRef: ref };
    },
  };
  return { engine, state };
}

function cfg(over: Partial<AutoChargeConfig> = {}): AutoChargeConfig {
  return {
    enabled: true,
    thresholdMicros: 10_000_000, // $10
    amountMicros: 50_000_000, // $50
    dailyCapMicros: 100_000_000, // $100
    monthlyCapMicros: 1_000_000_000, // $1000
    customerRef: "cus_1",
    paymentMethodRef: "pm_1",
    ...over,
  };
}

let eventSeq = 0;
function lowEvent(
  tenantId: string,
  over: { balanceMicros?: number; entryId?: string } = {},
): TenantBalanceEventData {
  const balanceMicros = over.balanceMicros ?? 1_000_000;
  return {
    entryId: over.entryId ?? `led_auto_${(eventSeq += 1)}`,
    tenantId,
    balanceMicros,
    balanceUsd: balanceMicros / 1_000_000,
    thresholdMicros: 2_000_000,
    thresholdUsd: 2,
    lifecycle: "active",
  };
}

describe.skipIf(!available)("auto-charge engine (real ledger)", () => {
  let harness: BackendHarness;

  beforeAll(async () => {
    harness = await startBackendHarness();
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.close();
  });

  function ledger() {
    return new HttpLedgerClient({ baseUrl: harness.baseUrl, provisionToken: harness.provisionToken });
  }

  // --- F3: rolling-window caps exercised with a MOVING clock -----------------

  it("DAILY cap: a charge inside the 24h window still counts; one that ages out does not", async () => {
    const tenantId = await harness.freshTenant();
    const store = new InMemoryAutoChargeStore();
    // amount $60, cap $100 — two charges can only both land if the first has aged out.
    store.setConfig(tenantId, cfg({ amountMicros: 60_000_000, dailyCapMicros: 100_000_000 }));
    const t0 = new Date("2026-07-18T12:00:00Z").getTime();
    let clock = t0;
    const engine = new AutoChargeEngine({
      engine: fakeEngine(async (n) => ({ ok: true, paymentRef: `pi_day_${n}` })),
      ledger: ledger(),
      store,
      notifier: { notifyDisabled: async () => {} },
      maxConsecutiveFailures: 3,
      now: () => new Date(clock),
    });

    // First charge at t0.
    expect((await engine.onLowBalance(lowEvent(tenantId))).outcome).toBe("charged");

    // Just INSIDE the window: the first charge still counts, so a second is capped.
    clock = t0 + DAY_MS - 1000;
    expect((await engine.onLowBalance(lowEvent(tenantId))).outcome).toBe("skipped_daily_cap");

    // Just OUTSIDE the window: the first charge has aged out, so a new one lands.
    clock = t0 + DAY_MS + 1000;
    expect((await engine.onLowBalance(lowEvent(tenantId))).outcome).toBe("charged");

    // Exactly at the window edge (now - DAY_MS === the first charge's time): the
    // strict `>` boundary excludes it, so the charge lands. A `>=` mutation would
    // instead count it and cap the charge — this pins the boundary.
    const edgeTenant = await harness.freshTenant();
    const edgeStore = new InMemoryAutoChargeStore();
    edgeStore.setConfig(edgeTenant, cfg({ amountMicros: 60_000_000, dailyCapMicros: 100_000_000 }));
    let edgeClock = t0;
    const edgeEngine = new AutoChargeEngine({
      engine: fakeEngine(async (n) => ({ ok: true, paymentRef: `pi_edge_${n}` })),
      ledger: ledger(),
      store: edgeStore,
      notifier: { notifyDisabled: async () => {} },
      maxConsecutiveFailures: 3,
      now: () => new Date(edgeClock),
    });
    expect((await edgeEngine.onLowBalance(lowEvent(edgeTenant))).outcome).toBe("charged");
    edgeClock = t0 + DAY_MS; // since === first charge time; `>` excludes it.
    expect((await edgeEngine.onLowBalance(lowEvent(edgeTenant))).outcome).toBe("charged");
  });

  it("MONTHLY cap: a charge inside the 30d window still counts; one that ages out does not", async () => {
    const tenantId = await harness.freshTenant();
    const store = new InMemoryAutoChargeStore();
    store.setConfig(
      tenantId,
      cfg({ amountMicros: 60_000_000, dailyCapMicros: 1_000_000_000, monthlyCapMicros: 100_000_000 }),
    );
    const t0 = new Date("2026-07-01T00:00:00Z").getTime();
    let clock = t0;
    const engine = new AutoChargeEngine({
      engine: fakeEngine(async (n) => ({ ok: true, paymentRef: `pi_mon_${n}` })),
      ledger: ledger(),
      store,
      notifier: { notifyDisabled: async () => {} },
      maxConsecutiveFailures: 3,
      now: () => new Date(clock),
    });

    expect((await engine.onLowBalance(lowEvent(tenantId))).outcome).toBe("charged");

    // Inside the 30-day window (but well past the daily window): still counts monthly.
    clock = t0 + MONTH_MS - DAY_MS;
    expect((await engine.onLowBalance(lowEvent(tenantId))).outcome).toBe("skipped_monthly_cap");

    // Outside the 30-day window: the first charge has aged out of the monthly cap.
    clock = t0 + MONTH_MS + 1000;
    expect((await engine.onLowBalance(lowEvent(tenantId))).outcome).toBe("charged");
  });

  // --- F1: redelivery of the SAME crossing charges + credits exactly once ----

  it("redelivered balance_low for the SAME crossing charges ONCE and credits ONCE (F1)", async () => {
    const tenantId = await harness.freshTenant();
    const store = new InMemoryAutoChargeStore();
    store.setConfig(tenantId, cfg());
    const { engine: fake, state } = idempotentEngine();
    let clock = new Date("2026-07-18T12:00:00Z").getTime();
    const engine = new AutoChargeEngine({
      engine: fake,
      ledger: ledger(),
      store,
      notifier: { notifyDisabled: async () => {} },
      maxConsecutiveFailures: 3,
      now: () => new Date(clock),
    });

    // The SAME crossing (one entryId), delivered twice — the wall clock advances
    // between deliveries (a real redelivery arrives seconds later). The OLD key
    // (`autocharge:<tenant>:<now>`) would differ across the two and double-charge; the
    // stable `autocharge:<entryId>` key collapses them.
    const crossing = lowEvent(tenantId, { entryId: "led_crossing_fixed" });
    const r1 = await engine.onLowBalance(crossing);
    clock += 5000;
    const r2 = await engine.onLowBalance(crossing);

    expect(r1.outcome).toBe("charged");
    expect(r2.outcome).toBe("charged");
    expect(state.charges).toBe(1); // exactly ONE real card charge
    expect(await harness.countTopups(tenantId)).toBe(1); // exactly ONE ledger credit
    expect(await harness.balanceMicros(tenantId)).toBe(50_000_000);
  });

  // --- F2: concurrent crossings for one tenant never race the cap ------------

  it("two concurrent crossings for one tenant are serialized — the cap is never exceeded (F2)", async () => {
    const tenantId = await harness.freshTenant();
    const store = new InMemoryAutoChargeStore();
    // amount $60, cap $100: two charges would be $120 > cap. Exactly one may land.
    store.setConfig(tenantId, cfg({ amountMicros: 60_000_000, dailyCapMicros: 100_000_000 }));
    const { engine: fake, state } = idempotentEngine({ delayMs: 20 });
    const engine = new AutoChargeEngine({
      engine: fake,
      ledger: ledger(),
      store,
      notifier: { notifyDisabled: async () => {} },
      maxConsecutiveFailures: 3,
      now: () => new Date("2026-07-18T12:00:00Z"),
    });

    // Two DISTINCT crossings fired concurrently. Without per-tenant serialization both
    // read the pre-charge total, both pass the $100 cap, and both charge ($120).
    const [a, b] = await Promise.all([
      engine.onLowBalance(lowEvent(tenantId, { entryId: "led_race_a" })),
      engine.onLowBalance(lowEvent(tenantId, { entryId: "led_race_b" })),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["charged", "skipped_daily_cap"]);
    expect(state.charges).toBe(1);
    expect(await harness.countTopups(tenantId)).toBe(1);
    expect(await harness.balanceMicros(tenantId)).toBe(60_000_000); // never $120
  });

  // --- Failure rails + shared-key money invariant (unchanged behavior) -------

  it("auto-disables + notifies after N consecutive failures — no silent retries, no charge", async () => {
    const tenantId = await harness.freshTenant();
    const store = new InMemoryAutoChargeStore();
    store.setConfig(tenantId, cfg());
    const notified: Array<{ tenantId: string; consecutiveFailures: number }> = [];
    const engine = new AutoChargeEngine({
      engine: fakeEngine(async () => ({ ok: false, failureCode: "card_declined" })),
      ledger: ledger(),
      store,
      notifier: {
        notifyDisabled: async (input) => {
          notified.push({ tenantId: input.tenantId, consecutiveFailures: input.consecutiveFailures });
        },
      },
      maxConsecutiveFailures: 3,
      now: () => new Date("2026-07-18T12:00:00Z"),
    });

    const f1 = await engine.onLowBalance(lowEvent(tenantId));
    const f2 = await engine.onLowBalance(lowEvent(tenantId));
    const f3 = await engine.onLowBalance(lowEvent(tenantId));

    expect(f1).toMatchObject({ outcome: "failed", consecutiveFailures: 1 });
    expect(f2).toMatchObject({ outcome: "failed", consecutiveFailures: 2 });
    expect(f3).toMatchObject({ outcome: "auto_disabled", consecutiveFailures: 3 });
    expect(notified).toEqual([{ tenantId, consecutiveFailures: 3 }]);

    // Disabled now: further low events are a no-op (no silent retry loop).
    expect((await engine.onLowBalance(lowEvent(tenantId))).outcome).toBe("skipped_disabled");
    expect((await store.getConfig(tenantId))?.enabled).toBe(false);
    expect(await harness.countTopups(tenantId)).toBe(0);
  });

  it("does not charge when auto-charge is disabled (off by default)", async () => {
    const tenantId = await harness.freshTenant();
    const store = new InMemoryAutoChargeStore(); // no config set → treated as disabled
    const engine = new AutoChargeEngine({
      engine: fakeEngine(async () => {
        throw new Error("must not charge when disabled");
      }),
      ledger: ledger(),
      store,
      notifier: { notifyDisabled: async () => {} },
      maxConsecutiveFailures: 3,
      now: () => new Date("2026-07-18T12:00:00Z"),
    });

    expect((await engine.onLowBalance(lowEvent(tenantId))).outcome).toBe("skipped_disabled");
    expect(await harness.countTopups(tenantId)).toBe(0);
  });

  it("the auto-charge's own webhook does NOT double-credit (shared idempotency key)", async () => {
    const tenantId = await harness.freshTenant();
    const store = new InMemoryAutoChargeStore();
    store.setConfig(tenantId, cfg());
    const sharedLedger = ledger();
    const engine = new AutoChargeEngine({
      engine: fakeEngine(async () => ({ ok: true, paymentRef: "pi_shared_1" })),
      ledger: sharedLedger,
      store,
      notifier: { notifyDisabled: async () => {} },
      maxConsecutiveFailures: 3,
      now: () => new Date("2026-07-18T12:00:00Z"),
    });

    const charged = await engine.onLowBalance(lowEvent(tenantId));
    expect(charged.outcome).toBe("charged");
    expect(await harness.countTopups(tenantId)).toBe(1);

    // Stripe delivers payment_intent.succeeded for the SAME PaymentIntent the
    // off-session charge created. Drive it through the real webhook path.
    const signer = new Stripe(DUMMY_SK);
    const payload = JSON.stringify({
      id: "evt_pi_shared_1",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_shared_1", amount: 5000, metadata: { tenantId } } },
    });
    const header = signer.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
    const webhookEngine = createStripeEngine({ secretKey: DUMMY_SK, webhookSecret: WEBHOOK_SECRET });
    const result = await handleWebhook({ engine: webhookEngine, ledger: sharedLedger }, payload, header);

    expect(result.credited).toBe(true);
    expect(result.applied).toBe(false); // deduped: stripe:pi_shared_1 already applied
    expect(await harness.countTopups(tenantId)).toBe(1); // still exactly one
    expect(await harness.balanceMicros(tenantId)).toBe(50_000_000);
  });
});
