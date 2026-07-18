/**
 * Shared saas commercialization widgets (WP-C5.4; console-spec §11.1/§11.8,
 * `console.md` §2a, journey W15). Used by both Home (the balance-first strip +
 * banners) and Settings → Billing, so the unverified / low-balance / suspended
 * states read identically wherever they surface (DP-9: the page states exactly
 * the one action that fixes it).
 *
 * §11.9: money is displayed verbatim from the API (`formatUsd(balanceUsd)`);
 * the ONLY derived figure is the runway *day count* (`lib/runway.ts`), which is
 * not money. The low-balance line is a boolean comparison against a display
 * threshold, not a computed dollar amount.
 */
import { Link } from "@tanstack/react-router";
import type { TenantBillingState, TenantUsageResponse } from "@pi-managed/contracts";

import { estimateRunwayDays } from "../../lib/runway.js";
import { Button } from "../../ui/button.js";
import { Sparkline } from "../../ui/sparkline.js";
import { StatusChip } from "../../ui/status-chip.js";
import { formatUsd } from "../sessions/format.js";
import styles from "./widgets.module.css";

/**
 * Display low-balance line ($2), mirroring the backend default
 * `BILLING_LOW_BALANCE_THRESHOLD_MICROS` (contracts
 * `DEFAULT_LOW_BALANCE_THRESHOLD_MICROS`). A plain literal — the console does
 * no money arithmetic (§11.9); this only decides whether to SHOW the banner.
 */
const LOW_BALANCE_DISPLAY_USD = 2;

/** Is the tenant an unverified trial (no active balance until they verify)? */
export function isUnverified(state: TenantBillingState): boolean {
  return state.verificationRequired;
}

/** Active tenant whose balance sits at/under the low-balance line (§11.6). */
export function isLowBalance(
  state: TenantBillingState,
  thresholdUsd = LOW_BALANCE_DISPLAY_USD,
): boolean {
  return (
    state.lifecycle === "active" &&
    !state.verificationRequired &&
    state.balanceUsd > 0 &&
    state.balanceUsd <= thresholdUsd
  );
}

// --- Unverified trial (§11.1) ------------------------------------------------

/**
 * The prominent unverified-trial notice + resend action. Surfaced on Home,
 * signup first-run, and Billing until the tenant verifies — the $5 trial grant
 * stays PENDING (no active balance, no new work) until then (§11.1).
 */
export function UnverifiedNotice({
  onResend,
  pending,
  outcome,
}: {
  onResend: () => void;
  pending: boolean;
  /** null = not yet attempted; "sent"/"noop" after; "error" on failure. */
  outcome: "sent" | "noop" | "error" | null;
}) {
  return (
    <section aria-label="Verify your email" className={styles.unverified} role="region">
      <p className={styles.noticeText}>
        <strong>Verify your email to activate your $5 trial.</strong> Your trial
        balance stays pending until you confirm — sessions can&apos;t start yet.
        Check your inbox for the link, or resend it.
      </p>
      <div className={styles.noticeActions}>
        <Button variant="primary" onClick={onResend} disabled={pending}>
          {pending ? "Sending…" : "Resend verification email"}
        </Button>
        {outcome === "sent" || outcome === "noop" ? (
          // Neutral either way — never reveals whether an email was on file.
          <span role="status" className={styles.noticeOk}>
            If your address is on file, a fresh link is on its way.
          </span>
        ) : null}
        {outcome === "error" ? (
          <span role="alert" className={styles.noticeErr}>
            Couldn&apos;t send right now — try again in a moment.
          </span>
        ) : null}
      </div>
    </section>
  );
}

// --- Low balance / suspended banners (§11.8, DP-9) ---------------------------

/**
 * Low-balance banner (§11.8): one line, one action. When the adapter is
 * present the action is "enable auto-charge in one click"; without it, "top up"
 * points at the Billing screen (which itself shows the no-adapter state).
 */
export function LowBalanceBanner({
  balanceUsd,
  onEnableAutoCharge,
}: {
  balanceUsd: number;
  /** Present ⇒ the adapter is configured; the button enables auto-charge. */
  onEnableAutoCharge?: () => void;
}) {
  return (
    <section aria-label="Low balance" className={styles.low} role="region">
      <p className={styles.noticeText}>
        <strong>Balance is low ({formatUsd(balanceUsd)}).</strong> Top up before
        it runs out — new sessions stop at zero.
      </p>
      <div className={styles.noticeActions}>
        {onEnableAutoCharge ? (
          <Button variant="primary" onClick={onEnableAutoCharge}>
            Enable auto-charge
          </Button>
        ) : null}
        <Link to="/settings/billing" className={styles.bannerLink}>
          Go to Billing
        </Link>
      </div>
    </section>
  );
}

/**
 * Suspended (balance ≤ 0) notice (§11.1/§11.8, DP-9): fail-soft — everything is
 * still readable, nothing new starts, and the page names the ONE fixing action.
 * `unverified` picks between the two causes (unverified trial vs drained).
 */
export function SuspendedNotice({
  unverified,
  fixAction,
}: {
  unverified: boolean;
  /** The single fixing action (a Top-up button, or a resend), or null when no
   * adapter is configured (then we state the out-of-console action). */
  fixAction: React.ReactNode;
}) {
  return (
    <section aria-label="Account suspended" className={styles.suspended} role="region">
      <p className={styles.noticeText}>
        <strong>New work is paused.</strong> Everything here is still readable —
        sessions, traces, usage — but no new session or turn can start until{" "}
        {unverified
          ? "you verify your email and activate your trial."
          : "you add funds."}
      </p>
      <div className={styles.noticeActions}>
        {fixAction ?? (
          <span className={styles.noticeErr}>
            Top-ups aren&apos;t available on this deployment — add funds through
            your provider to resume.
          </span>
        )}
      </div>
    </section>
  );
}

// --- Home balance headline (§11.8, DP-14) ------------------------------------

/**
 * The saas Home balance element: current balance, a burn sparkline over the
 * API's per-day spend, and "lasts ~N days at current rate" (a day-count
 * projection, not money — §11.9). Usage may still be loading; the sparkline and
 * runway simply omit until it arrives.
 */
export function BalanceHeadline({
  state,
  usage,
}: {
  state: TenantBillingState;
  usage: TenantUsageResponse | undefined;
}) {
  const runway = estimateRunwayDays(state.balanceUsd, usage);
  const dailyCosts = usage?.data.map((bucket) => bucket.usdCost) ?? [];

  return (
    <section aria-label="Balance" className={styles.headline}>
      <div className={styles.balanceMain}>
        <span className={styles.balanceValue}>{formatUsd(state.balanceUsd)}</span>
        <span className={styles.balanceLabel}>
          balance <StatusChip status={state.lifecycle} />
        </span>
      </div>
      {dailyCosts.length >= 2 ? (
        <div className={styles.burn}>
          <Sparkline
            values={dailyCosts}
            width={160}
            height={28}
            label="Daily spend, USD"
          />
          <span className={styles.runway}>
            {runway === null
              ? "runway needs a day or two of usage"
              : `lasts ~${runway} day${runway === 1 ? "" : "s"} at current rate`}
          </span>
        </div>
      ) : null}
    </section>
  );
}
