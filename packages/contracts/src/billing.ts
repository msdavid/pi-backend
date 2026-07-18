/**
 * @pi-managed/contracts — Commercialization / ledger (saas). WP-C5.1.
 *
 * Mirrors docs/api-reference.md §"Billing (saas)" and console spec §11. The
 * prepaid dollar balance and its history live in the backend ledger (§11.3) —
 * the source of truth for balance; nothing client-side computes money (§11.9),
 * so every money figure the console renders comes from these shapes.
 *
 * **Unit.** All ledger amounts are integer **micro-dollars** (`micros`): 1 USD =
 * 1_000_000 micros. Integers avoid float rounding on money; the `*Usd` companion
 * fields are the server's already-divided convenience value the console displays
 * (it never divides itself). Amounts are SIGNED — credits (grant/topup) are
 * positive, debits negative — so `balanceAfterMicros = sum(amountMicros)`.
 */

import { z } from "zod";
import { Timestamp } from "./common.js";
import { ledgerEntryId } from "./ids.js";

/** 1 USD in micro-dollars (the ledger's smallest single unit, §11.3). */
export const MICROS_PER_USD = 1_000_000;

/**
 * Default low-balance threshold (µUSD) — $2. The server config
 * (`BILLING_LOW_BALANCE_THRESHOLD_MICROS`) overrides it; the emitter fires
 * `tenant.balance_low` when a debit crosses DOWN through this line (§11.6).
 */
export const DEFAULT_LOW_BALANCE_THRESHOLD_MICROS = 2 * MICROS_PER_USD;

/**
 * Default metering aggregation bucket width (ms) — 1 minute. The server config
 * (`BILLING_METERING_BUCKET_MS`) overrides it. Usage is summed per tenant per bucket
 * into one export event + one ledger debit (§11.4, never per-turn).
 */
export const DEFAULT_METERING_BUCKET_MS = 60_000;

// --- Tenant lifecycle (§11.1) ----------------------------------------------

/**
 * Tenant billing lifecycle. `trial → active`, plus `suspended` (balance ≤ 0).
 * There is deliberately NO `past_due` — prepaid cannot be past due (§11.1).
 */
export const BillingLifecycle = z.enum(["trial", "active", "suspended"]);
export type BillingLifecycle = z.infer<typeof BillingLifecycle>;

/**
 * Tenant billing state (`GET /v1/tenant/billing`). Absent-adapter degradation and
 * suspended rendering (§11.8) key off `lifecycle`; the unverified-trial gate
 * (§11.1) keys off `verificationRequired`.
 */
export const TenantBillingState = z.object({
  lifecycle: BillingLifecycle,
  /** Current balance in micro-dollars (integer, canonical). */
  balanceMicros: z.number().int(),
  /** Server-computed `balanceMicros / 1_000_000` — the console displays this (§11.9). */
  balanceUsd: z.number(),
  /** True once the email-verification trial grant has activated (§11.1). */
  verified: z.boolean(),
  /**
   * True when the tenant still needs email verification to gain an active
   * balance (unverified trial). The console surfaces the resend action (§11.1).
   */
  verificationRequired: z.boolean(),
});
export type TenantBillingState = z.infer<typeof TenantBillingState>;

// --- Ledger entries (§11.3) -------------------------------------------------

/**
 * Ledger entry kind. All balance movements are entries: `grant` (trial / promo),
 * `topup` (a payment credit), `debit` (usage drain), `adjustment` (manual
 * correction, either sign).
 */
export const LedgerEntryKind = z.enum(["grant", "topup", "debit", "adjustment"]);
export type LedgerEntryKind = z.infer<typeof LedgerEntryKind>;

/** A single append-only ledger entry (§11.3). */
export const LedgerEntry = z.object({
  id: ledgerEntryId,
  kind: LedgerEntryKind,
  /** Signed amount in micro-dollars (credits positive, debits negative). */
  amountMicros: z.number().int(),
  /** Server-computed `amountMicros / 1_000_000` (§11.9). */
  amountUsd: z.number(),
  /** Running balance in micro-dollars immediately after this entry. */
  balanceAfterMicros: z.number().int(),
  /** Server-computed `balanceAfterMicros / 1_000_000` (§11.9). */
  balanceAfterUsd: z.number(),
  /** Free-text provenance (`trial`, `stripe`, `manual`, …); never a secret. */
  source: z.string().nullable(),
  createdAt: Timestamp,
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;

// --- Email verification (§11.1) --------------------------------------------

/** `POST /v1/onboarding/verify-email` body — the single-use token from the email. */
export const VerifyEmailRequest = z.object({
  token: z.string().min(1),
});
export type VerifyEmailRequest = z.infer<typeof VerifyEmailRequest>;

/**
 * `POST /v1/onboarding/verify-email` result. Idempotent: a replay (already-verified
 * token) still returns `verified: true` and does not re-grant (§11.1).
 */
export const VerifyEmailResponse = z.object({
  verified: z.literal(true),
});
export type VerifyEmailResponse = z.infer<typeof VerifyEmailResponse>;

/**
 * `POST /v1/tenant/billing/verification/resend` result (§11.1). `sent` is `false`
 * — a benign no-op, not an error — when the tenant is already verified or has no
 * email on file; the console shows a neutral acknowledgement either way (it never
 * reveals which of those two the no-op was, to avoid leaking account existence).
 */
export const VerificationResendResponse = z.object({
  sent: z.boolean(),
});
export type VerificationResendResponse = z.infer<typeof VerificationResendResponse>;

// --- Adapter-integration surface (§11.7–11.8; billing-adapter proxy) --------

/**
 * Auto-charge configuration (§11.7, `console.md` §2a). Opt-in, **off by default**:
 * when the balance drops below `threshold`, the adapter charges `amount` to the
 * saved payment method (saved-method + off-session charging are adapter-internal —
 * the console only ever reads/writes this settings shape, never card data, §11.9).
 * Hard `daily`/`monthly` caps bound the spend a runaway agent can trigger; after N
 * consecutive payment failures the adapter auto-disables and sets `disabledReason`
 * (never a silent retry loop). Every auto-charge lands in the ledger like a top-up,
 * so `lastCharge*` mirror the newest such entry.
 *
 * Money is server-divided (§11.9): the console displays the `*Usd` companions and
 * never derives them. This shape is served by the deployment's billing-adapter
 * proxy — a console with no adapter configured gets `404` and shows the no-adapter
 * state (money controls absent, §11.8), never this object.
 */
export const AutoChargeConfig = z.object({
  /** Off by default (§11.7). */
  enabled: z.boolean(),
  /** Balance level (µUSD) at/below which a charge fires. */
  thresholdMicros: z.number().int().nonnegative(),
  thresholdUsd: z.number().nonnegative(),
  /** Amount (µUSD) charged when it fires. */
  amountMicros: z.number().int().nonnegative(),
  amountUsd: z.number().nonnegative(),
  /** Hard cap (µUSD) on auto-charges per rolling day — never exceeded (§11.7). */
  dailyCapMicros: z.number().int().nonnegative(),
  dailyCapUsd: z.number().nonnegative(),
  /** Hard cap (µUSD) on auto-charges per rolling month — never exceeded (§11.7). */
  monthlyCapMicros: z.number().int().nonnegative(),
  monthlyCapUsd: z.number().nonnegative(),
  /** The newest auto-charge, or `null` if none has fired yet. */
  lastChargeAt: Timestamp.nullable(),
  lastChargeUsd: z.number().nonnegative().nullable(),
  /**
   * Set (with `enabled:false`) when the adapter auto-disabled after repeated
   * payment failures — the console tells the user and points at manual top-up.
   */
  disabledReason: z.enum(["consecutive_failures"]).nullable(),
});
export type AutoChargeConfig = z.infer<typeof AutoChargeConfig>;

/**
 * `PATCH /v1/tenant/billing/auto-charge` body. Amounts are the user-entered **USD**
 * figures (never micro-math in the browser, §11.9) — the adapter converts to micros
 * at the engine boundary. All fields optional so the toggle and the numbers update
 * independently.
 */
export const AutoChargeUpdate = z.object({
  enabled: z.boolean().optional(),
  thresholdUsd: z.number().nonnegative().optional(),
  amountUsd: z.number().positive().optional(),
});
export type AutoChargeUpdate = z.infer<typeof AutoChargeUpdate>;

/**
 * `POST /v1/tenant/billing/checkout` body. `amountUsd` is the user-entered top-up in
 * dollars (adapter converts to micros). Omitted ⇒ the adapter's hosted page lets the
 * user pick — the console never handles the amount as money math (§11.9).
 */
export const CheckoutSessionRequest = z.object({
  amountUsd: z.number().positive().optional(),
});
export type CheckoutSessionRequest = z.infer<typeof CheckoutSessionRequest>;

/**
 * A hosted link the adapter issues on request (§11.7–11.8): the console redirects
 * the browser to `url` (hosted checkout or the receipts/payment-method portal) — the
 * card is entered on the payment engine's page, never in the console (§11.9). Used
 * for both `POST …/checkout` and `POST …/portal` responses.
 */
export const BillingHostedLink = z.object({
  url: z.string().url(),
});
export type BillingHostedLink = z.infer<typeof BillingHostedLink>;

// --- Metering export (§11.4, WP-C5.2) --------------------------------------

/**
 * A metering export event — the published `BILLING_SINK=webhook` payload
 * (console spec §11.4). It is **time-bucketed and aggregated, never per-turn**:
 * the metering aggregator sums every model request a tenant made in a fixed
 * wall-clock window `[bucketStart, bucketEnd)` into ONE event and posts it to the
 * operator-configured billing endpoint (HMAC-signed, at-least-once).
 *
 * `idempotencyKey` is stable per `(tenantId, bucketStart)` — a re-delivery
 * (retry, or a bucket re-flushed after a transient failure) carries the SAME key,
 * so the recipient dedups and never double-bills. This schema is the contract a
 * sink consumer validates each delivery against.
 */
export const MeteringEvent = z.object({
  /** Stable dedup key: `meter:<tenantId>:<bucketStartEpochMs>`. */
  idempotencyKey: z.string().min(1),
  tenantId: z.string().min(1),
  /** Inclusive start of the aggregation window (ISO-8601 UTC). */
  bucketStart: Timestamp,
  /** Exclusive end of the aggregation window (ISO-8601 UTC). */
  bucketEnd: Timestamp,
  /** Model requests aggregated into this bucket. */
  requestCount: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheCreationInputTokens: z.number().int().nonnegative(),
  cacheReadInputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  /** Aggregated USD cost over the bucket (marked-up model spend, §11.1). */
  usdCost: z.number().nonnegative(),
});
export type MeteringEvent = z.infer<typeof MeteringEvent>;

// --- Threshold events (§11.6, WP-C5.2) -------------------------------------

/**
 * The `data` payload carried by the `tenant.balance_low` / `tenant.balance_exhausted`
 * webhook events (console spec §11.6). It carries what a consumer needs at the
 * moment of the crossing — tenant, the AT-CROSSING balance, and the configured
 * threshold — so email / auto-charge / the console banner act without a round-trip
 * (the live balance moves on). Money is server-divided (§11.9): both `*Micros` and
 * the display `*Usd` are present.
 *
 * `entryId` is the STABLE identity of the crossing: the ledger entry (the usage
 * debit) that caused it. It is unique per crossing and survives webhook redelivery /
 * a metering re-flush unchanged (unlike `balanceMicros`/`threshold`, which are not a
 * dedup key). Consumers that act on a crossing — notably the auto-charge engine —
 * MUST derive their idempotency key from `entryId` so a re-delivered event triggers
 * at most one charge (WP-C5.2 / WP-C5.3).
 */
export const TenantBalanceEventData = z.object({
  /** The ledger entry (usage debit) that caused this crossing — the replay-safe
   * idempotency key for consumers (auto-charge). Stable across redelivery. */
  entryId: ledgerEntryId,
  tenantId: z.string().min(1),
  /** Balance (µUSD) immediately after the debit that triggered the event. */
  balanceMicros: z.number().int(),
  balanceUsd: z.number(),
  /** The low threshold (µUSD) in effect. For `balance_exhausted` this is the ≤0 line. */
  thresholdMicros: z.number().int().nonnegative(),
  thresholdUsd: z.number(),
  /** Tenant lifecycle after the crossing (`active` at low, `suspended` at exhausted). */
  lifecycle: BillingLifecycle,
});
export type TenantBalanceEventData = z.infer<typeof TenantBalanceEventData>;
