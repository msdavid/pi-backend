/**
 * Webhook auto-disable (WP-2.5, §23.5).
 *
 * A webhook is auto-disabled (`status='disabled'` + machine-readable
 * `disabledReason`) when:
 * - a delivery **streak** reaches the threshold (default ~20 consecutive
 *   failures across retries of a single delivery — the `attempt` column), or
 * - the endpoint hostname resolves to a private IP (immediate), or
 * - the endpoint returns a `3xx` redirect (immediate; redirects are NOT
 *   followed, §23.5).
 *
 * Disabled webhooks are skipped by the dispatcher until manually re-enabled
 * (status set back to `active`); there is no automatic re-enable.
 */

import { tenantScopedQuery, type Pool, type TenantCtx } from "../../infra/db/index.js";

/** Consecutive-failure threshold before auto-disable (§23.5 "≈20"). */
export const DISABLE_STREAK_THRESHOLD = 20;

export const DISABLE_REASON = {
  streak: "auto-disabled:consecutive-failures",
  privateIp: "auto-disabled:ssrf-private-ip",
  redirect: "auto-disabled:redirect-not-followed",
} as const;

/**
 * Disable a webhook immediately with a machine-readable `reason`. Idempotent:
 * a no-op if already disabled for the same (or any) reason.
 */
export async function disableWebhook(
  pool: Pool,
  tenantCtx: TenantCtx,
  webhookId: string,
  reason: string,
): Promise<void> {
  await tenantScopedQuery(
    pool,
    tenantCtx,
    `UPDATE webhooks
        SET status = 'disabled', disabled_reason = $3, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'active'`,
    [tenantCtx.tenantId, webhookId, reason],
  );
}

/**
 * Whether a delivery streak has crossed the auto-disable threshold.
 * The dispatcher passes the current `attempt` (1-based) of a failed delivery.
 */
export function shouldDisableForStreak(
  attempt: number,
  threshold: number = DISABLE_STREAK_THRESHOLD,
): boolean {
  return attempt >= threshold;
}
