/**
 * Trial grant + email verification (console spec §11.1, WP-C5.1).
 *
 * Signup grants a **$5 trial balance, no card, activated only on email
 * verification** (decision §10.8). The grant is a normal ledger entry (§11.3)
 * that is PENDING until the emailed token is verified — so an unverified tenant
 * has NO active balance and (in saas) cannot start work, the intended anti-abuse
 * gate.
 *
 * - {@link provisionTrial} — at signup: creates the `tenant_billing` row, records
 *   a verification token (hash only) + expiry + the pending grant amount, and
 *   sends the verification email through the {@link EmailSender} seam.
 * - {@link resendVerification} — regenerates the token and re-sends (invalidating
 *   the previous link — single-use on resend). No-op once verified.
 * - {@link verifyEmail} — activates the pending grant EXACTLY ONCE (idempotent:
 *   the grant's deterministic idempotency key makes a replay / second-verify a
 *   no-op) and moves the tenant `trial → active`.
 */

import { createHash, randomBytes } from "node:crypto";
import { MICROS_PER_USD } from "@pi-managed/contracts";
import { query, type Pool } from "../../infra/db/index.js";
import { ApiError } from "../errors.js";
import type { EmailSender } from "../ports.js";
import { appendEntry, ensureBillingRow, getBillingRow } from "./ledger.js";

/** The trial grant: $5, activated on email verification (decision §10.8). */
export const TRIAL_GRANT_MICROS = 5 * MICROS_PER_USD;

/** Verification-token lifetime: 7 days. Resend issues a fresh token. */
export const VERIFICATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Template name handed to the {@link EmailSender} for the verification email. */
export const VERIFICATION_EMAIL_TEMPLATE = "trial-email-verification";

/** SHA-256 hex of a raw token (only the hash is ever stored). */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The deterministic idempotency key for a tenant's one-and-only trial grant. */
function trialGrantKey(tenantId: string): string {
  return `trial-grant:${tenantId}`;
}

/**
 * Provision (or re-provision) a tenant's trial: create the billing row, set a
 * fresh verification token + expiry + pending grant, and send the verification
 * email. No-op (returns without sending) if the tenant is already verified.
 * Returns the raw token ONLY for the caller to hand to the email sender — it is
 * never persisted or returned on the wire.
 */
export async function provisionTrial(
  pool: Pool,
  tenantId: string,
  email: string,
  emailSender: EmailSender,
  opts: { now?: () => Date; grantMicros?: number } = {},
): Promise<{ sent: boolean }> {
  const now = opts.now?.() ?? new Date();
  await ensureBillingRow(pool, tenantId);

  const existing = await getBillingRow(pool, tenantId);
  if (existing?.verifiedAt) return { sent: false };

  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(now.getTime() + VERIFICATION_TTL_MS);
  const grantMicros = opts.grantMicros ?? TRIAL_GRANT_MICROS;

  // Only (re)arm verification while unverified — never clobber a verified tenant.
  await query(
    pool,
    `UPDATE tenant_billing
        SET verification_token_hash = $2,
            verification_expires_at = $3,
            pending_grant_micros = $4,
            updated_at = now()
      WHERE tenant_id = $1 AND verified_at IS NULL`,
    [tenantId, tokenHash, expiresAt, grantMicros],
  );

  await emailSender.send({
    to: email,
    template: VERIFICATION_EMAIL_TEMPLATE,
    vars: { token, tenantId },
  });
  return { sent: true };
}

/** The admin email for a tenant (from the onboarding record), or `null`. */
export async function emailForTenant(pool: Pool, tenantId: string): Promise<string | null> {
  const { rows } = await query<{ admin_email: string }>(
    pool,
    "SELECT admin_email FROM onboarding_signups WHERE tenant_id = $1 LIMIT 1",
    [tenantId],
  );
  return rows[0]?.admin_email ?? null;
}

/**
 * Resend the verification email to a tenant (tenant-scoped console action, §11.1).
 * Regenerates the token (invalidating the previous link) and re-sends. Returns
 * `{ sent: false }` if the tenant is already verified or has no on-file email.
 */
export async function resendVerification(
  pool: Pool,
  tenantId: string,
  emailSender: EmailSender,
  opts: { now?: () => Date } = {},
): Promise<{ sent: boolean }> {
  const row = await getBillingRow(pool, tenantId);
  if (row?.verifiedAt) return { sent: false };
  const email = await emailForTenant(pool, tenantId);
  if (!email) return { sent: false };
  return provisionTrial(pool, tenantId, email, emailSender, opts);
}

/**
 * Verify an emailed token: activate the pending trial grant EXACTLY ONCE and move
 * the tenant `trial → active`. Idempotent — a replay (already-verified token)
 * returns success without re-granting, because the grant's deterministic
 * idempotency key ({@link trialGrantKey}) is enforced transactionally by the
 * ledger's UNIQUE constraint. An invalid token → 404; an expired, never-verified
 * token → 409.
 */
export async function verifyEmail(
  pool: Pool,
  token: string,
  opts: { now?: () => Date } = {},
): Promise<{ verified: true }> {
  const now = opts.now?.() ?? new Date();
  const tokenHash = hashToken(token);

  const { rows } = await query<{
    tenant_id: string;
    pending_grant_micros: string;
    verified_at: Date | null;
    verification_expires_at: Date | null;
  }>(
    pool,
    `SELECT tenant_id, pending_grant_micros, verified_at, verification_expires_at
       FROM tenant_billing WHERE verification_token_hash = $1`,
    [tokenHash],
  );
  const row = rows[0];
  if (!row) {
    throw new ApiError(404, "not_found", "invalid or unknown verification token");
  }

  // Already verified with this token ⇒ idempotent no-op success.
  if (row.verified_at) return { verified: true };

  if (row.verification_expires_at && row.verification_expires_at.getTime() < now.getTime()) {
    throw new ApiError(
      409,
      "conflict",
      "verification token has expired; request a new verification email",
    );
  }

  const tenantId = row.tenant_id;
  const pending = Number(row.pending_grant_micros);
  if (pending > 0) {
    // Exactly-once: the deterministic key makes concurrent / replayed verifies
    // apply the grant only once (the ledger UNIQUE constraint is the gate).
    await appendEntry(
      pool,
      {
        tenantId,
        kind: "grant",
        amountMicros: pending,
        idempotencyKey: trialGrantKey(tenantId),
        source: "trial",
        metadata: { reason: "email-verified trial grant" },
      },
      { forceLifecycle: "active" },
    );
  }

  // Mark verified + clear the pending amount. Idempotent (COALESCE keeps the
  // first verified_at under a concurrent second verify).
  await query(
    pool,
    `UPDATE tenant_billing
        SET verified_at = COALESCE(verified_at, now()),
            pending_grant_micros = 0,
            updated_at = now()
      WHERE tenant_id = $1`,
    [tenantId],
  );

  return { verified: true };
}
