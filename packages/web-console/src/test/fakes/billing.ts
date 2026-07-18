/**
 * `/v1/tenant/billing` family of the {@link FakeConsoleApi} (WP-C5.4; saas
 * commercialization). Models the two tiers the console reads:
 *
 *  - **Ledger tier:** `GET /v1/tenant/billing` (state; `null` ⇒ `404`
 *    "not enrolled / no billing"), `GET …/ledger`, `POST …/verification/resend`,
 *    `POST /v1/onboarding/verify-email` (activates the trial — flips the state
 *    to verified/active and appends the $5 grant, so the
 *    unverified→resend→verified loop is drivable end-to-end).
 *  - **Adapter tier:** `GET/PATCH …/auto-charge` (config; `null` ⇒ `404`
 *    "no adapter" — the single presence signal), `POST …/checkout` / `…/portal`
 *    (hosted URLs). Set `autoChargeConfig` to a config to model an adapter
 *    being present; leave it `null` for the no-adapter degradation (§11.8).
 *
 * Money figures are wire-shaped (both `*Micros` and the `*Usd` companion) so the
 * real contracts schemas validate them, exactly like the backend.
 */
import type {
  AutoChargeConfig,
  LedgerEntry,
  TenantBillingState,
} from "@pi-managed/contracts";

import { ConsoleApiError } from "../../api/client.js";
import { invalidRequest, notFound } from "./wire.js";
import { pageOf } from "./wire.js";

/** A 409 the real backend returns for an expired verification token (§11.1). */
function verificationConflict(): ConsoleApiError {
  return new ConsoleApiError("verification link expired", {
    status: 409,
    code: "conflict",
    type: "request_error",
    requestId: "req_01TESTREQUEST",
  });
}

/** A wire-shaped billing state (contracts `TenantBillingState`). */
export function makeBillingState(
  overrides: Partial<TenantBillingState> = {},
): TenantBillingState {
  return {
    lifecycle: "active",
    balanceMicros: 5_000_000,
    balanceUsd: 5,
    verified: true,
    verificationRequired: false,
    ...overrides,
  };
}

/** A wire-shaped ledger entry (contracts `LedgerEntry`). */
export function makeLedgerEntry(
  overrides: Partial<LedgerEntry> & { id: string },
): LedgerEntry {
  return {
    kind: "grant",
    amountMicros: 5_000_000,
    amountUsd: 5,
    balanceAfterMicros: 5_000_000,
    balanceAfterUsd: 5,
    source: "trial",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A wire-shaped auto-charge config (contracts `AutoChargeConfig`). Off by
 * default — set it as the fake's `autoChargeConfig` to model an adapter. */
export function makeAutoCharge(
  overrides: Partial<AutoChargeConfig> = {},
): AutoChargeConfig {
  return {
    enabled: false,
    thresholdMicros: 10_000_000,
    thresholdUsd: 10,
    amountMicros: 50_000_000,
    amountUsd: 50,
    dailyCapMicros: 100_000_000,
    dailyCapUsd: 100,
    monthlyCapMicros: 500_000_000,
    monthlyCapUsd: 500,
    lastChargeAt: null,
    lastChargeUsd: null,
    disabledReason: null,
    ...overrides,
  };
}

/** The slice of {@link FakeConsoleApi} state this family reads/writes. */
export interface BillingState {
  /** `null` ⇒ `GET /v1/tenant/billing` 404s (tenant not enrolled). */
  billingState: TenantBillingState | null;
  /** Ledger history, newest first. */
  ledgerEntries: LedgerEntry[];
  /** `null` ⇒ no adapter (money controls absent, §11.8). */
  autoChargeConfig: AutoChargeConfig | null;
  /** What `POST …/verification/resend` reports. */
  resendSent: boolean;
  /** Hosted URL the checkout/portal link-outs return. */
  hostedUrl: string;
}

/** `GET` handlers for the billing family; `undefined` if the path is unmatched. */
export function billingGet(
  state: BillingState,
  pathname: string,
  params: URLSearchParams,
): unknown | undefined {
  if (pathname === "/v1/tenant/billing") {
    if (!state.billingState) throw notFound("billing");
    return state.billingState;
  }
  if (pathname === "/v1/tenant/billing/ledger") {
    return pageOf(state.ledgerEntries, params);
  }
  if (pathname === "/v1/tenant/billing/auto-charge") {
    if (!state.autoChargeConfig) throw notFound("auto-charge");
    return state.autoChargeConfig;
  }
  return undefined;
}

/** `POST` handlers for the billing family; `undefined` if the path is unmatched. */
export function billingPost(
  state: BillingState,
  path: string,
  body: unknown,
): unknown | undefined {
  if (path === "/v1/onboarding/verify-email") {
    const token = (body as { token?: string }).token;
    // Sentinel tokens exercise the failure branches the landing renders.
    if (token === "tok_expired") throw verificationConflict();
    if (token === "tok_bad") throw notFound("verification token");
    // Idempotent activation: flip to verified/active + append the $5 grant.
    if (state.billingState) {
      state.billingState = {
        ...state.billingState,
        lifecycle: "active",
        verified: true,
        verificationRequired: false,
      };
    }
    if (!state.ledgerEntries.some((e) => e.source === "trial")) {
      state.ledgerEntries.unshift(
        makeLedgerEntry({ id: "led_01GRANT", kind: "grant" }),
      );
    }
    return { verified: true };
  }
  if (path === "/v1/tenant/billing/verification/resend") {
    return { sent: state.resendSent };
  }
  if (path === "/v1/tenant/billing/checkout") {
    // The reference adapter issues a FIXED-amount hosted page, so an explicit
    // positive amount is required — an omitted/invalid amount is a 422, exactly
    // as the real backend proxy relays it (§11.7). The console's top-up dialog
    // always sends one.
    const amountUsd = (body as { amountUsd?: unknown }).amountUsd;
    if (typeof amountUsd !== "number" || !(amountUsd > 0)) {
      throw invalidRequest("amountUsd (positive) is required by the reference engine");
    }
    return { url: state.hostedUrl };
  }
  if (path === "/v1/tenant/billing/portal") {
    return { url: state.hostedUrl };
  }
  return undefined;
}

/** `PATCH` handler for auto-charge; `undefined` if unmatched. */
export function billingPatch(
  state: BillingState,
  path: string,
  body: unknown,
): unknown | undefined {
  if (path !== "/v1/tenant/billing/auto-charge") return undefined;
  if (!state.autoChargeConfig) throw notFound("auto-charge");
  const update = body as {
    enabled?: boolean;
    thresholdUsd?: number;
    amountUsd?: number;
  };
  // Apply the USD figures; keep the *Micros companions consistent (the real
  // adapter converts at the boundary — here we mirror x1_000_000 in the FAKE
  // only, never in the console under test).
  const next = { ...state.autoChargeConfig };
  if (update.enabled !== undefined) next.enabled = update.enabled;
  if (update.thresholdUsd !== undefined) {
    next.thresholdUsd = update.thresholdUsd;
    next.thresholdMicros = update.thresholdUsd * 1_000_000;
  }
  if (update.amountUsd !== undefined) {
    next.amountUsd = update.amountUsd;
    next.amountMicros = update.amountUsd * 1_000_000;
  }
  state.autoChargeConfig = next;
  return next;
}
