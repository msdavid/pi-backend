/**
 * Trial + email verification integration (console spec §11.1, WP-C5.1) — real
 * Postgres. Drives the production trial provisioning + verification against a real
 * DB with the {@link NoopEmailSender} standing in for the collaborator email
 * provider (it records sent messages so the test reads the token, exactly the
 * dev/test contract). Pins: an unverified tenant has NO active balance; verifying
 * activates the grant EXACTLY once (replay is a no-op); resend rotates the token.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPool,
  closePool,
  query,
  runMigrations,
  type Pool,
} from "../../../infra/db/index.js";
import { startPostgres, type TestDb } from "../../../infra/db/__tests__/test-runtime.js";
import { createTenant } from "../../tenant/tenant.js";
import { NoopEmailSender } from "../../email/noop-email-sender.js";
import { ApiError } from "../../errors.js";
import { getBillingState } from "../ledger.js";
import {
  provisionTrial,
  resendVerification,
  verifyEmail,
  TRIAL_GRANT_MICROS,
  VERIFICATION_EMAIL_TEMPLATE,
} from "../trial.js";

describe("trial + verification (integration)", () => {
  let db: TestDb;
  let pool: Pool;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  async function freshTenant(email: string): Promise<string> {
    const t = await createTenant(pool, { name: `Trial ${Math.random()}` });
    // Record the email → tenant link so `resendVerification` can find the address.
    await query(
      pool,
      "INSERT INTO onboarding_signups (admin_email, tenant_id) VALUES ($1, $2)",
      [email, t.id],
    );
    return t.id;
  }

  function tokenFrom(mailer: NoopEmailSender, to: string): string {
    const msg = mailer.lastTo(to);
    expect(msg).toBeDefined();
    expect(msg?.template).toBe(VERIFICATION_EMAIL_TEMPLATE);
    return msg!.vars.token;
  }

  it("unverified tenant has no active balance; verification activates the grant exactly once", async () => {
    const email = `a-${Math.random()}@example.test`;
    const tenantId = await freshTenant(email);
    const mailer = new NoopEmailSender();

    await provisionTrial(pool, tenantId, email, mailer);

    // Unverified: trial lifecycle, zero balance, verification still required.
    const before = await getBillingState(pool, tenantId);
    expect(before?.lifecycle).toBe("trial");
    expect(before?.balanceMicros).toBe(0);
    expect(before?.verified).toBe(false);
    expect(before?.verificationRequired).toBe(true);

    const token = tokenFrom(mailer, email);
    const res = await verifyEmail(pool, token);
    expect(res.verified).toBe(true);

    const after = await getBillingState(pool, tenantId);
    expect(after?.lifecycle).toBe("active");
    expect(after?.balanceMicros).toBe(TRIAL_GRANT_MICROS);
    expect(after?.verified).toBe(true);
    expect(after?.verificationRequired).toBe(false);

    // Second verify with the same token is a no-op (grant applied exactly once).
    const replay = await verifyEmail(pool, token);
    expect(replay.verified).toBe(true);
    const final = await getBillingState(pool, tenantId);
    expect(final?.balanceMicros).toBe(TRIAL_GRANT_MICROS);
    // Exactly one grant entry exists.
    const { rows } = await query<{ count: string }>(
      pool,
      "SELECT count(*)::text AS count FROM ledger_entries WHERE tenant_id = $1 AND kind = 'grant'",
      [tenantId],
    );
    expect(rows[0].count).toBe("1");
  });

  it("rejects an invalid token", async () => {
    await expect(verifyEmail(pool, "not-a-real-token")).rejects.toMatchObject({
      statusCode: 404,
    } satisfies Partial<ApiError>);
  });

  it("rejects an expired, never-verified token", async () => {
    const email = `exp-${Math.random()}@example.test`;
    const tenantId = await freshTenant(email);
    const mailer = new NoopEmailSender();
    // Provision with a clock far in the past so the token is already expired.
    await provisionTrial(pool, tenantId, email, mailer, {
      now: () => new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
    const token = tokenFrom(mailer, email);
    await expect(verifyEmail(pool, token)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("resend rotates the token, invalidating the previous link", async () => {
    const email = `re-${Math.random()}@example.test`;
    const tenantId = await freshTenant(email);
    const mailer = new NoopEmailSender();
    await provisionTrial(pool, tenantId, email, mailer);
    const firstToken = tokenFrom(mailer, email);

    const { sent } = await resendVerification(pool, tenantId, mailer);
    expect(sent).toBe(true);
    const secondToken = tokenFrom(mailer, email);
    expect(secondToken).not.toBe(firstToken);

    // The old link no longer works; the new one does.
    await expect(verifyEmail(pool, firstToken)).rejects.toMatchObject({ statusCode: 404 });
    const ok = await verifyEmail(pool, secondToken);
    expect(ok.verified).toBe(true);

    // Once verified, resend is a no-op.
    const again = await resendVerification(pool, tenantId, mailer);
    expect(again.sent).toBe(false);
  });
});
