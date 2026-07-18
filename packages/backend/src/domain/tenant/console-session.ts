/**
 * Console-session store (WP-C1.2, console spec §4).
 *
 * Binds a random browser-cookie token to a validated API key so the console
 * never holds the key in JS-readable storage (§4.1). Storage is a Postgres
 * table — `console_sessions`, migration 041 — per the decided design
 * (docs/console.md §10.1): sign-out and key revocation take effect server-side
 * immediately, the sliding TTL (§4.6) is a column update, and a future "list
 * active console sessions" needs no new store.
 *
 * - The raw token is NEVER stored — only its SHA-256 hash. Unlike the API key
 *   itself (argon2id, §8), a fast hash suffices here: the token is 256 bits of
 *   CSPRNG output, so it cannot be dictionary-attacked; hashing only ensures a
 *   leaked table row is not replayable as a cookie.
 * - Resolution joins `api_keys` and fails on `revoked_at` — revoking the
 *   underlying key invalidates its console sessions on next use (§4.6). Hard
 *   key deletion cascades (FK `ON DELETE CASCADE`).
 * - Sliding TTL: each successful resolution re-extends `expires_at`, throttled
 *   to ~once/min per session (mirrors `bumpLastUsed` in `api-key.ts`, PERF-11)
 *   so an active console tab does not fire an UPDATE per request.
 * - Expiry sweep: expired rows are deleted opportunistically on session
 *   create (§4.7) — sign-ins are rare, the index on `expires_at` makes the
 *   sweep cheap, and no background timer is needed.
 */

import { createHash, randomBytes } from "node:crypto";
import { query, type Pool } from "../../infra/db/index.js";
import type { ConsoleMode } from "@pi-managed/contracts";

/** Per-mode sliding-TTL defaults in seconds (console spec §4.6, decided docs/console.md §10.3). */
export const CONSOLE_SESSION_TTL_DEFAULTS: Record<ConsoleMode, number> = {
  solo: 30 * 24 * 60 * 60, // 30 days
  team: 7 * 24 * 60 * 60, // 7 days
  saas: 24 * 60 * 60, // 24 hours
};

/** Min gap between sliding-TTL `expires_at` writes for one session. */
const BUMP_THROTTLE_MS = 60_000;
/**
 * Per-session wall-clock of the last TTL bump. Only sessions that resolve
 * successfully are recorded (an attacker cannot grow it), an entry is evicted
 * when its session stops resolving (unknown/expired/revoked) or signs out, and
 * records older than the throttle window — behaviorally inert, since a missing
 * record also bumps — are swept opportunistically ({@link sweepLastBumps}). The
 * map is therefore bounded by the sessions resolved within the last
 * {@link BUMP_THROTTLE_MS}.
 */
const lastBumps = new Map<string, number>();
/** Epoch ms of the last {@link sweepLastBumps} pass. */
let lastBumpsSweep = 0;

/**
 * Drop bump records older than the throttle window, at most once per window
 * (mirrors `FailedAuthThrottle.sweep`). A record past the window never
 * throttles anything — resolution bumps whether it is present or not — so
 * dropping it is purely a bound on the map.
 */
function sweepLastBumps(now: number): void {
  if (now - lastBumpsSweep < BUMP_THROTTLE_MS) return;
  lastBumpsSweep = now;
  for (const [hash, at] of lastBumps) {
    if (now - at >= BUMP_THROTTLE_MS) lastBumps.delete(hash);
  }
}

/** Live bump-record count (introspection for tests / bounds). */
export function bumpRecordCount(): number {
  return lastBumps.size;
}

/** SHA-256 hex of the raw cookie token — the only form ever persisted. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A freshly created console session; `token` is returned once, as the cookie value. */
export interface CreatedConsoleSession {
  token: string;
  expiresAt: Date;
}

/** A resolved (cookie-authenticated) console session. */
export interface ResolvedConsoleSession {
  tenantId: string;
  /** The underlying API key's scopes — same authority as the key (§4.3). */
  scopes: string[];
  expiresAt: Date;
}

/**
 * Create a console session for an already-verified API key. Generates a
 * 256-bit random token (the cookie value), stores only its hash, and sweeps
 * expired rows opportunistically (§4.7).
 */
export async function createConsoleSession(
  pool: Pool,
  input: { apiKeyId: string; tenantId: string; ttlSeconds: number },
): Promise<CreatedConsoleSession> {
  // Opportunistic expiry sweep (§4.7): sign-ins are rare and the expires_at
  // index makes this cheap, so no background reaper timer is needed.
  await query(pool, `DELETE FROM console_sessions WHERE expires_at < now()`);
  const token = randomBytes(32).toString("base64url");
  const { rows } = await query<{ expires_at: Date }>(
    pool,
    `INSERT INTO console_sessions (token_hash, api_key_id, tenant_id, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4))
     RETURNING expires_at`,
    [hashToken(token), input.apiKeyId, input.tenantId, input.ttlSeconds],
  );
  return { token, expiresAt: rows[0].expires_at };
}

/**
 * Resolve a raw cookie token → {@link ResolvedConsoleSession}, or `null` if the
 * session is unknown, expired, or its API key has been revoked (§4.6). A
 * successful resolution slides the TTL (`expires_at = now() + ttl`), throttled
 * to once per {@link BUMP_THROTTLE_MS} per session.
 *
 * @param nowMs clock source (injectable for deterministic throttle tests,
 *              mirrors `FailedAuthThrottleOptions.now`). Default `Date.now`.
 */
export async function resolveConsoleSession(
  pool: Pool,
  token: string,
  ttlSeconds: number,
  nowMs: () => number = Date.now,
): Promise<ResolvedConsoleSession | null> {
  const tokenHash = hashToken(token);
  const { rows } = await query<{
    tenant_id: string;
    expires_at: Date;
    scopes: string[] | null;
    revoked_at: Date | null;
  }>(
    pool,
    `SELECT cs.tenant_id, cs.expires_at, k.scopes, k.revoked_at
       FROM console_sessions cs
       JOIN api_keys k ON k.id = cs.api_key_id
      WHERE cs.token_hash = $1`,
    [tokenHash],
  );
  const row = rows[0];
  const now = nowMs();
  if (!row || row.revoked_at || row.expires_at.getTime() <= now) {
    // Unknown / revoked (§4.6) / expired-awaiting-sweep — evict any bump
    // record so a dead session cannot pin a map entry for the process
    // lifetime (the map stays bounded by *live* sessions).
    lastBumps.delete(tokenHash);
    return null;
  }

  let expiresAt = row.expires_at;
  sweepLastBumps(now);
  const prev = lastBumps.get(tokenHash);
  if (prev === undefined || now - prev >= BUMP_THROTTLE_MS) {
    lastBumps.set(tokenHash, now);
    const bumped = await query<{ expires_at: Date }>(
      pool,
      `UPDATE console_sessions
          SET expires_at = now() + make_interval(secs => $2), last_seen_at = now()
        WHERE token_hash = $1
      RETURNING expires_at`,
      [tokenHash, ttlSeconds],
    );
    if (bumped.rows[0]) expiresAt = bumped.rows[0].expires_at;
  }
  return {
    tenantId: row.tenant_id,
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
    expiresAt,
  };
}

/** Destroy a console session by its raw cookie token (sign-out, §4.4). Idempotent. */
export async function deleteConsoleSession(
  pool: Pool,
  token: string,
): Promise<void> {
  const tokenHash = hashToken(token);
  lastBumps.delete(tokenHash);
  await query(pool, `DELETE FROM console_sessions WHERE token_hash = $1`, [
    tokenHash,
  ]);
}
