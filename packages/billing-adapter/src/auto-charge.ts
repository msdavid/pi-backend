/**
 * Auto-charge engine (console spec §11.7 — opt-in, OFF by default).
 *
 * Subscribes (via the caller) to the backend's `tenant.balance_low` webhook event
 * ({@link TenantBalanceEventData}, WP-C5.2). When a tenant has opted in, it
 * off-session charges the saved payment method for the configured amount and
 * credits the ledger like any other top-up. The safety rails are non-negotiable
 * (§11.7):
 *
 * - **Hard caps per day AND per month** — a charge that WOULD push the rolling
 *   window over its cap is skipped, never partially applied. The cap can never be
 *   exceeded.
 * - **Auto-disable after N consecutive failures** — no silent retry loops. On the
 *   Nth consecutive failure the tenant's auto-charge is disabled and the user is
 *   notified; manual top-up remains.
 * - **Every auto-charge appears in the ledger** — through the SAME credit path and
 *   idempotency key as a manual top-up ({@link creditKeyForPayment}); the
 *   off-session charge's own webhook therefore does not double-credit.
 *
 * Saved-method state, per-tenant config, cap accounting, and the failure counter
 * are adapter-internal. {@link InMemoryAutoChargeStore} is the reference store
 * (and the test double); a production deployment backs the same interface with a
 * real datastore.
 */

import type { TenantBalanceEventData } from "@pi-managed/contracts";
import { creditKeyForPayment } from "./credit-key.js";
import type { LedgerClient, PaymentEngine } from "./types.js";

/** Rolling window widths for the caps. */
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * DAY_MS;

/** A tenant's auto-charge configuration (adapter-internal). */
export interface AutoChargeConfig {
  /** OFF by default — a tenant must opt in. */
  enabled: boolean;
  /** Charge when the balance drops below this (µUSD). */
  thresholdMicros: number;
  /** Amount to charge each time (µUSD). */
  amountMicros: number;
  /** Hard cap on total auto-charges in a rolling 24 h window (µUSD). */
  dailyCapMicros: number;
  /** Hard cap on total auto-charges in a rolling 30-day window (µUSD). */
  monthlyCapMicros: number;
  /** Engine customer handle (adapter-internal; NOT a card). */
  customerRef: string;
  /** Engine saved-payment-method handle (adapter-internal; NOT a card number). */
  paymentMethodRef: string;
}

/** Partial auto-charge change from the console's PATCH (§11.7). Caps + saved-method
 * handles are operator/engine-managed and never set here. */
export interface AutoChargeConfigPatch {
  enabled?: boolean;
  thresholdMicros?: number;
  amountMicros?: number;
}

/**
 * Adapter-internal store for auto-charge config, cap accounting, and failure count.
 *
 * **Cap atomicity (WP-C5.3 F2).** `sumChargesSince` + `recordCharge` are a
 * check-then-act pair. {@link AutoChargeEngine.onLowBalance} serializes per tenant
 * so two crossings for one tenant never interleave *within a process* — but that
 * guard is in-process only. A production store spanning processes MUST make the
 * reservation transactional: reserve the amount against the rolling-window cap under
 * a row lock (or a conditional insert) BEFORE the engine charge, so two concurrent
 * workers cannot both pass the cap. The in-memory reference is single-process and
 * relies on the engine lock alone.
 */
export interface AutoChargeStore {
  /** The tenant's config, or `null` if it has never been set up. */
  getConfig(tenantId: string): Promise<AutoChargeConfig | null>;
  /**
   * Apply the console's auto-charge PATCH (enabled / threshold / amount), upserting
   * the tenant's config and returning the result. Caps and the saved-method handles
   * are untouched.
   */
  updateConfig(tenantId: string, patch: AutoChargeConfigPatch): Promise<AutoChargeConfig>;
  /** Disable auto-charge (after N consecutive failures). */
  disable(tenantId: string): Promise<void>;
  /** Sum of SUCCESSFUL auto-charges for the tenant strictly after `since` (µUSD). */
  sumChargesSince(tenantId: string, since: Date): Promise<number>;
  /** Record a successful auto-charge (for cap accounting). */
  recordCharge(tenantId: string, amountMicros: number, at: Date): Promise<void>;
  /** Current consecutive-failure count. */
  getConsecutiveFailures(tenantId: string): Promise<number>;
  /** Set the consecutive-failure count (0 resets it after a success). */
  setConsecutiveFailures(tenantId: string, n: number): Promise<void>;
}

/** Notified when auto-charge auto-disables (the user must know — no silent failure). */
export interface AutoChargeNotifier {
  notifyDisabled(input: {
    tenantId: string;
    consecutiveFailures: number;
    lastFailureCode?: string;
  }): Promise<void>;
}

/** Why an auto-charge run ended. Every non-`charged` outcome is a no-op on the card. */
export type AutoChargeOutcome =
  | "charged"
  | "skipped_disabled"
  | "skipped_above_threshold"
  | "skipped_daily_cap"
  | "skipped_monthly_cap"
  | "failed"
  | "auto_disabled";

export interface AutoChargeResult {
  outcome: AutoChargeOutcome;
  amountMicros?: number;
  entryId?: string;
  /** Consecutive-failure count after this run (on `failed` / `auto_disabled`). */
  consecutiveFailures?: number;
}

export interface AutoChargeEngineDeps {
  engine: PaymentEngine;
  ledger: LedgerClient;
  store: AutoChargeStore;
  notifier: AutoChargeNotifier;
  /** Consecutive failures that trigger auto-disable (default 3, `AUTO_CHARGE_MAX_FAILURES`). */
  maxConsecutiveFailures: number;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => Date;
}

export class AutoChargeEngine {
  private readonly deps: AutoChargeEngineDeps;
  private readonly now: () => Date;
  /** Per-tenant serialization tails — the keyed async mutex (WP-C5.3 F2). */
  private readonly tenantTails = new Map<string, Promise<void>>();

  constructor(deps: AutoChargeEngineDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Run `fn` under a per-`key` mutex so calls for the SAME tenant execute strictly
   * one at a time (WP-C5.3 F2). The cap check + charge + `recordCharge` are a
   * check-then-act sequence; without this, two concurrent crossings for one tenant
   * both read the pre-charge total, both pass the cap, and both charge — exceeding
   * it. Serializing per tenant makes the second crossing observe the first's
   * recorded charge. This is an IN-PROCESS guard; a multi-process deployment also
   * needs the store's transactional reservation (see {@link AutoChargeStore}).
   */
  private async withTenantLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tenantTails.get(key) ?? Promise.resolve();
    const result = prev.then(fn, fn);
    // A non-rejecting tail so one call's failure never breaks the next call's chain.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tenantTails.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.tenantTails.get(key) === tail) this.tenantTails.delete(key);
    }
  }

  /**
   * Handle one `tenant.balance_low` crossing. Returns the outcome without throwing
   * for a decline (a decline advances the failure counter; the caller logs the
   * result). Serialized per tenant (F2) so concurrent crossings never race the cap.
   */
  onLowBalance(event: TenantBalanceEventData): Promise<AutoChargeResult> {
    return this.withTenantLock(event.tenantId, () => this.runLowBalance(event));
  }

  private async runLowBalance(event: TenantBalanceEventData): Promise<AutoChargeResult> {
    const { store, engine, ledger, notifier, maxConsecutiveFailures } = this.deps;
    const tenantId = event.tenantId;

    const config = await store.getConfig(tenantId);
    if (!config || !config.enabled) {
      return { outcome: "skipped_disabled" };
    }
    // The low event means the balance already crossed below the tenant's line; this
    // guards a stale/duplicate event so it never charges an already-topped-up tenant.
    if (event.balanceMicros >= config.thresholdMicros) {
      return { outcome: "skipped_above_threshold" };
    }

    const now = this.now();
    // Cap check BEFORE charging: a charge that would push either rolling window over
    // its cap is skipped entirely (never exceed, never partial).
    const chargedToday = await store.sumChargesSince(tenantId, new Date(now.getTime() - DAY_MS));
    if (chargedToday + config.amountMicros > config.dailyCapMicros) {
      return { outcome: "skipped_daily_cap" };
    }
    const chargedMonth = await store.sumChargesSince(tenantId, new Date(now.getTime() - MONTH_MS));
    if (chargedMonth + config.amountMicros > config.monthlyCapMicros) {
      return { outcome: "skipped_monthly_cap" };
    }

    // Engine-side idempotency key derived from the STABLE crossing id (the causing
    // ledger debit), NOT wall-clock (WP-C5.3 F1). A redelivered/retried
    // `tenant.balance_low` for the SAME crossing carries the same `entryId`, so the
    // engine returns the SAME payment (one real card charge) and the ledger key
    // below (from that payment id) dedupes the credit — one charge, one credit, no
    // matter how many times the event is delivered. Passed through to the engine's
    // idempotency key (Stripe's `Idempotency-Key`).
    const chargeKey = `autocharge:${event.entryId}`;
    const charge = await engine.chargeOffSession({
      tenantId,
      customerRef: config.customerRef,
      paymentMethodRef: config.paymentMethodRef,
      amountMicros: config.amountMicros,
      idempotencyKey: chargeKey,
    });

    if (!charge.ok) {
      const n = (await store.getConsecutiveFailures(tenantId)) + 1;
      await store.setConsecutiveFailures(tenantId, n);
      if (n >= maxConsecutiveFailures) {
        await store.disable(tenantId);
        await notifier.notifyDisabled({
          tenantId,
          consecutiveFailures: n,
          ...(charge.failureCode ? { lastFailureCode: charge.failureCode } : {}),
        });
        return { outcome: "auto_disabled", consecutiveFailures: n };
      }
      return { outcome: "failed", consecutiveFailures: n };
    }

    // Success: reset the failure counter and credit the ledger like any top-up
    // (idempotent on the payment id).
    await store.setConsecutiveFailures(tenantId, 0);
    const credit = await ledger.credit({
      tenantId,
      amountMicros: config.amountMicros,
      idempotencyKey: creditKeyForPayment(charge.paymentRef as string),
      source: "stripe-autocharge",
      metadata: { paymentRef: charge.paymentRef, autoCharge: true },
    });
    // Count toward the cap ONLY when the ledger applied a NEW credit. A redelivered
    // crossing (same entryId → same engine key → same payment id) dedupes here
    // (`applied:false`), so it must not double-count against the rolling-window cap.
    if (credit.applied) {
      await store.recordCharge(tenantId, config.amountMicros, now);
    }
    return { outcome: "charged", amountMicros: config.amountMicros, entryId: credit.entryId };
  }
}

/**
 * Reference in-memory {@link AutoChargeStore} — the test double and the shape a
 * production store mirrors. Not durable; a real deployment persists config, the
 * charge log (for caps), and the failure counter.
 */
export class InMemoryAutoChargeStore implements AutoChargeStore {
  private readonly configs = new Map<string, AutoChargeConfig>();
  private readonly charges = new Map<string, Array<{ amountMicros: number; at: Date }>>();
  private readonly failures = new Map<string, number>();

  /** Seed or replace a tenant's config (stands in for the console's save action). */
  setConfig(tenantId: string, config: AutoChargeConfig): void {
    this.configs.set(tenantId, config);
  }

  async getConfig(tenantId: string): Promise<AutoChargeConfig | null> {
    return this.configs.get(tenantId) ?? null;
  }

  /**
   * Upsert the console-settable fields (enabled / threshold / amount). A brand-new
   * tenant gets a default-off config with zero caps and empty saved-method handles —
   * a production store instead seeds caps from operator config and carries the saved
   * customer/payment-method established when a card was first saved (checkout/portal).
   */
  async updateConfig(tenantId: string, patch: AutoChargeConfigPatch): Promise<AutoChargeConfig> {
    const base: AutoChargeConfig = this.configs.get(tenantId) ?? {
      enabled: false,
      thresholdMicros: 0,
      amountMicros: 0,
      dailyCapMicros: 0,
      monthlyCapMicros: 0,
      customerRef: "",
      paymentMethodRef: "",
    };
    const next: AutoChargeConfig = {
      ...base,
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.thresholdMicros !== undefined ? { thresholdMicros: patch.thresholdMicros } : {}),
      ...(patch.amountMicros !== undefined ? { amountMicros: patch.amountMicros } : {}),
    };
    this.configs.set(tenantId, next);
    return next;
  }

  async disable(tenantId: string): Promise<void> {
    const config = this.configs.get(tenantId);
    if (config) this.configs.set(tenantId, { ...config, enabled: false });
  }

  async sumChargesSince(tenantId: string, since: Date): Promise<number> {
    const log = this.charges.get(tenantId) ?? [];
    return log
      .filter((c) => c.at.getTime() > since.getTime())
      .reduce((sum, c) => sum + c.amountMicros, 0);
  }

  async recordCharge(tenantId: string, amountMicros: number, at: Date): Promise<void> {
    const log = this.charges.get(tenantId) ?? [];
    log.push({ amountMicros, at });
    this.charges.set(tenantId, log);
  }

  async getConsecutiveFailures(tenantId: string): Promise<number> {
    return this.failures.get(tenantId) ?? 0;
  }

  async setConsecutiveFailures(tenantId: string, n: number): Promise<void> {
    this.failures.set(tenantId, n);
  }
}
