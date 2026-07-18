/**
 * Suspension enforcement (console spec §11.1, WP-C5.1).
 *
 * Fail-soft prepaid suspension: a saas tenant whose balance is ≤ 0 (either an
 * unverified trial with no active grant, or a drained `suspended` account) MUST
 * NOT start NEW work — new sessions and new turns are blocked — but reads are
 * unaffected (this helper is called only on the session-start / turn-start path,
 * never on a read). Running work stops via the existing `budget_exhausted`
 * machinery; this helper only gates the START of new work.
 *
 * **This never calls a payment engine.** It reads only local ledger state
 * (`tenant_billing`, one indexed single-row lookup, §11.3).
 *
 * **saas-only.** Enforcement is gated on `billingEnabled` (the deliberate saas
 * switch, config `BILLING_ENABLED`) — NOT on the presentation `mode`, which by
 * §3.3 may not change any `/v1` behavior. Solo/team self-hosters run with
 * `billingEnabled=false` and bypass this entirely; a tenant not enrolled in the
 * ledger (no `tenant_billing` row) is likewise never blocked.
 */

import { ApiError } from "../errors.js";
import { type Pool } from "../../infra/db/index.js";
import { getBillingRow } from "./ledger.js";

/**
 * Assert the tenant may start new work, or throw a taxonomy-consistent
 * {@link ApiError}. No-op when `billingEnabled` is false (solo/team) or the
 * tenant is not enrolled in the ledger.
 *
 * The thrown error uses `code: "budget_exhausted"` (the spec ties suspension to
 * `budget_exhausted` semantics, §11.1) at HTTP `402`, with `details.reason`
 * distinguishing the unverified-trial gate from a drained balance so the console
 * can point at the single fixing action (§11.8 / DP-9).
 */
export async function assertCanStartWork(
  pool: Pool,
  tenantId: string,
  billingEnabled: boolean,
): Promise<void> {
  if (!billingEnabled) return;
  const row = await getBillingRow(pool, tenantId);
  if (!row) return; // not enrolled in the ledger ⇒ not balance-gated.
  if (row.balanceMicros > 0) return;

  if (row.lifecycle === "trial" && !row.verifiedAt) {
    throw new ApiError(
      402,
      "budget_exhausted",
      "Verify your email to activate your $5 trial balance before starting work.",
      { reason: "trial_unverified" },
    );
  }
  throw new ApiError(
    402,
    "budget_exhausted",
    "Your balance is exhausted; top up to resume starting new sessions and turns. Existing data stays readable.",
    { reason: "balance_exhausted" },
  );
}
