/**
 * Console-session store domain tests (WP-C1.2, console spec §4.6).
 *
 * Covers the sliding-TTL bump throttle and the bounds of its per-process
 * `lastBumps` map (PERF-11 mirror):
 * - a resolution inside the ~1-min window does NOT rewrite `expires_at`; one
 *   past the window does (deterministic via the injectable clock, the same
 *   pattern as `FailedAuthThrottle`);
 * - a session that stops resolving (expired here; revoked/unknown share the
 *   path) is evicted from the map instead of pinning an entry for the process
 *   lifetime;
 * - records older than the throttle window (behaviorally inert) are swept
 *   opportunistically, so the map stays bounded by recently-active sessions.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  createPool,
  closePool,
  query,
  runMigrations,
  type Pool,
} from "../../../infra/db/index.js";
import { startPostgres, type TestDb } from "../../../infra/db/__tests__/test-runtime.js";
import { createTenant } from "../tenant.js";
import { issueApiKey } from "../api-key.js";
import {
  bumpRecordCount,
  createConsoleSession,
  resolveConsoleSession,
} from "../console-session.js";

/** Sliding TTL used throughout — short enough to spot an unbumped row. */
const TTL = 3600;
/** The store's bump-throttle window (BUMP_THROTTLE_MS). */
const WINDOW_MS = 60_000;

describe("console-session store: bump throttle + map bounds (§4.6)", () => {
  let db: TestDb;
  let pool: Pool;
  let tenantId: string;
  let apiKeyId: string;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
    const t = await createTenant(pool, { name: "Console Store Tenant" });
    tenantId = t.id;
    apiKeyId = (
      await issueApiKey(pool, { tenantId }, { name: "console-store-key" })
    ).id;
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  function hashOf(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  async function expiresAtOf(tokenHash: string): Promise<Date> {
    const { rows } = await query<{ expires_at: Date }>(
      pool,
      `SELECT expires_at FROM console_sessions WHERE token_hash = $1`,
      [tokenHash],
    );
    return rows[0].expires_at;
  }

  it("bumps are throttled to ~once per window; past the window the TTL slides again", async () => {
    const t0 = Date.now();
    const s = await createConsoleSession(pool, { apiKeyId, tenantId, ttlSeconds: TTL });
    const tokenHash = hashOf(s.token);

    // First resolution of a fresh token always bumps (no record yet).
    expect(await resolveConsoleSession(pool, s.token, TTL, () => t0)).not.toBeNull();

    // Shrink expires_at so a bump — if one happened — would be visible (kept
    // comfortably beyond the injected clocks below so the row never reads as
    // expired mid-test).
    await query(
      pool,
      `UPDATE console_sessions SET expires_at = now() + interval '5 minutes'
        WHERE token_hash = $1`,
      [tokenHash],
    );

    // Inside the window: still resolves, but must NOT rewrite expires_at.
    expect(
      await resolveConsoleSession(pool, s.token, TTL, () => t0 + WINDOW_MS / 2),
    ).not.toBeNull();
    const unbumped = await expiresAtOf(tokenHash);
    expect(unbumped.getTime()).toBeLessThan(Date.now() + 10 * 60_000);

    // Past the window: the TTL slides back out to ~TTL from now.
    expect(
      await resolveConsoleSession(pool, s.token, TTL, () => t0 + WINDOW_MS + 1000),
    ).not.toBeNull();
    const bumped = await expiresAtOf(tokenHash);
    expect(bumped.getTime()).toBeGreaterThan(Date.now() + (TTL - 60) * 1000);
  });

  it("a session that stops resolving is evicted from the bump map", async () => {
    const s = await createConsoleSession(pool, { apiKeyId, tenantId, ttlSeconds: TTL });
    const tokenHash = hashOf(s.token);
    expect(await resolveConsoleSession(pool, s.token, TTL)).not.toBeNull();
    const withRecord = bumpRecordCount();

    // Expire it server-side: the failed resolution returns null AND drops the
    // bump record — a dead session must not pin a map entry forever.
    await query(
      pool,
      `UPDATE console_sessions SET expires_at = now() - interval '1 second'
        WHERE token_hash = $1`,
      [tokenHash],
    );
    expect(await resolveConsoleSession(pool, s.token, TTL)).toBeNull();
    expect(bumpRecordCount()).toBe(withRecord - 1);
  });

  it("stale bump records are swept opportunistically (bounded by recent activity)", async () => {
    const a = await createConsoleSession(pool, { apiKeyId, tenantId, ttlSeconds: TTL });
    const b = await createConsoleSession(pool, { apiKeyId, tenantId, ttlSeconds: TTL });
    // Base clock safely past anything earlier tests injected, so the sweep
    // cadence (at most once per window) is under this test's control.
    const base = Date.now() + 10 * WINDOW_MS;
    expect(await resolveConsoleSession(pool, a.token, TTL, () => base)).not.toBeNull();
    expect(await resolveConsoleSession(pool, b.token, TTL, () => base)).not.toBeNull();
    const withBoth = bumpRecordCount();

    // Two windows later only `a` comes back: `b`'s record — now inert, a
    // missing record bumps too — is swept; `a`'s is refreshed in place.
    expect(
      await resolveConsoleSession(pool, a.token, TTL, () => base + 2 * WINDOW_MS),
    ).not.toBeNull();
    expect(bumpRecordCount()).toBe(withBoth - 1);
  });
});
