/**
 * API-key service (§8, §"Authentication", §"Tenant / admin").
 *
 * - Raw key format: `pmb_live_<ulid>_<secret>` — the `pmb_live_` prefix per
 *   api-reference.md, with the key's ULID embedded for O(1) lookup and a
 *   32-char random secret. To a client the whole suffix is opaque/random.
 * - The raw key is **never stored** — only its argon2id hash (§8). `verifyApiKey`
 *   re-derives the candidate api-key row from the embedded ULID, then
 *   `argon2.verify` confirms the secret against the stored hash.
 * - {@link verifyApiKey} resolves a raw key → {@link TenantCtx} (or `null`),
 *   which is what the auth middleware attaches to every request.
 */

import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import {
  query,
  tenantScopedQuery,
  type Pool,
  type TenantCtx,
} from "../../infra/db/index.js";
import { newId, ULID_PATTERN } from "./ids.js";
import { apiKeyCache } from "./api-key-cache.js";
import type { ApiKey, ApiKeyCreate } from "@pi-managed/contracts";

const KEY_PREFIX = "pmb_live_";
const SECRET_LEN = 32;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Min gap between `last_used_at` writes for one key (PERF-11). */
const LAST_USED_THROTTLE_MS = 60_000;
/**
 * Per-key wall-clock of the last `last_used_at` write, throttling the bump to at
 * most once/minute per key so an authenticated request stream no longer fires an
 * UPDATE (WAL churn + hot-row bloat + a pool checkout) on every single call.
 * Bounded by the number of genuinely valid keys — an attacker cannot grow it.
 */
const lastUsedWrites = new Map<string, number>();

/**
 * Fire-and-forget bump of a key's `last_used_at`, throttled per {@link
 * LAST_USED_THROTTLE_MS}. Never blocks auth or throws on failure.
 */
function bumpLastUsed(pool: Pool, apikeyId: string): void {
  const now = Date.now();
  const prev = lastUsedWrites.get(apikeyId);
  if (prev !== undefined && now - prev < LAST_USED_THROTTLE_MS) return;
  lastUsedWrites.set(apikeyId, now);
  void query(pool, `UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [
    apikeyId,
  ]).catch(() => {});
}

/**
 * A throwaway argon2id hash used only to equalize verification timing on the
 * miss path (SEC-14): an unknown or revoked key id must spend ~the same time as
 * a live one, otherwise the early return is a timing oracle distinguishing real
 * key ids from non-existent ones. Computed once, lazily, with the same default
 * argon2 params `issueApiKey` uses so the verify cost matches.
 */
let decoyHashPromise: Promise<string> | undefined;
function decoyHash(): Promise<string> {
  return (decoyHashPromise ??= argon2.hash(`decoy_${randomSecret()}`));
}

/** A newly issued key — the ONLY response that includes the raw `key`. */
export interface IssuedApiKey {
  id: string;
  name: string;
  key: string;
  scopes: string[];
  createdAt: string; // RFC 3339
}

/** `^pmb_live_(<ulid>)_(<secret>)$` — captures the embedded key ULID for lookup. */
const KEY_REGEX = new RegExp(`^${KEY_PREFIX}(${ULID_PATTERN})_([0-9A-HJKMNP-TV-Z]{${SECRET_LEN}})$`);

/**
 * Extract the `apikey_…` id embedded in a raw key, or `null` if malformed.
 * WP-C1.2: console-session creation stores the key's id (FK → `api_keys`) so
 * key revocation/deletion invalidates the session — after {@link verifyApiKey}
 * has accepted the key, this recovers its id without a second DB read.
 */
export function apiKeyIdFromRawKey(rawKey: string): string | null {
  const match = KEY_REGEX.exec(rawKey);
  return match ? `apikey_${match[1]}` : null;
}

/** Generate a `SECRET_LEN`-char Crockford-Base32 secret (256 % 32 == 0 → no bias). */
function randomSecret(): string {
  const bytes = randomBytes(SECRET_LEN);
  let str = "";
  for (let i = 0; i < SECRET_LEN; i++) {
    str += CROCKFORD[bytes[i] % 32];
  }
  return str;
}

/**
 * Build the raw key shown once at issuance: `pmb_live_<keyUlid>_<secret>`.
 * `<keyUlid>` is the ULID payload of `apikey_<ulid>` — re-derivable on verify.
 */
function buildRawKey(apikeyId: string): string {
  const ulidPart = apikeyId.slice("apikey_".length);
  return `${KEY_PREFIX}${ulidPart}_${randomSecret()}`;
}

/**
 * Issue an API key for `tenantCtx`. Hashes the raw key with argon2id and stores
 * only the hash; returns the raw `key` **once**.
 */
export async function issueApiKey(
  pool: Pool,
  tenantCtx: TenantCtx,
  input: ApiKeyCreate,
): Promise<IssuedApiKey> {
  const id = newId("apikey_");
  const rawKey = buildRawKey(id);
  const keyHash = await argon2.hash(rawKey);
  // Omitted scopes default to `["admin"]` — backward-compat for internal /
  // bootstrap callers (e.g. onboarding's signup admin key), matching the
  // pre-R0.1 behavior where every key was effectively tenant-admin (migration
  // 028 backfills existing rows the same way). This is NOT the public issuance
  // default: `POST /v1/api-keys` (api/tenant.ts) always passes an explicit
  // `scopes: parsed.data.scopes ?? ["read"]` for least privilege and must not
  // rely on this fallback.
  const scopes = input.scopes ?? ["admin"];
  const { rows } = await tenantScopedQuery<{ created_at: Date }>(
    pool,
    tenantCtx,
    `INSERT INTO api_keys (id, tenant_id, key_hash, name, scopes)
       VALUES ($1, $2, $3, $4, $5)
     RETURNING created_at`,
    [id, tenantCtx.tenantId, keyHash, input.name, JSON.stringify(scopes)],
  );
  return {
    id,
    name: input.name,
    key: rawKey,
    scopes,
    createdAt: rows[0].created_at.toISOString(),
  };
}

/** List a tenant's API keys. Never includes the raw key (or its hash). */
export async function listApiKeys(
  pool: Pool,
  tenantCtx: TenantCtx,
): Promise<ApiKey[]> {
  const { rows } = await tenantScopedQuery<{
    id: string;
    name: string;
    scopes: string[];
    created_at: Date;
    revoked_at: Date | null;
  }>(
    pool,
    tenantCtx,
    `SELECT id, name, scopes, created_at, revoked_at
       FROM api_keys
      WHERE tenant_id = $1
      ORDER BY created_at DESC`,
    [tenantCtx.tenantId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    scopes: r.scopes,
    createdAt: r.created_at.toISOString(),
    ...(r.revoked_at ? { revokedAt: r.revoked_at.toISOString() } : {}),
  }));
}

/**
 * Revoke a key (set `revoked_at`). Returns `true` if a live key was revoked,
 * `false` if the key was absent (or in another tenant, or already revoked) —
 * callers map `false` to `404 not_found` (same response to avoid leakage).
 */
export async function revokeApiKey(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
): Promise<boolean> {
  const { rowCount } = await tenantScopedQuery(
    pool,
    tenantCtx,
    `UPDATE api_keys SET revoked_at = now()
      WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL`,
    [tenantCtx.tenantId, id],
  );
  const revoked = (rowCount ?? 0) > 0;
  if (revoked) {
    // Drop the cached verification so this instance stops honoring the key at
    // once. Other replicas keep serving it until their cached entry expires
    // (revocation latency there is bounded by ApiKeyCache's TTL). Only on an
    // actual revoke, so a cross-tenant no-op can't flush another tenant's entry.
    apiKeyCache.invalidate(id);
  }
  return revoked;
}

/**
 * Verify a raw bearer key → {@link TenantCtx}, or `null` if the key is
 * malformed, absent, revoked, or fails argon2 verification.
 *
 * Lookup is O(1): the key embeds its own api-key ULID, so we read that single
 * row, then `argon2.verify` the stored hash against the full raw key.
 *
 * A recently-verified key takes a fast path through {@link apiKeyCache} that
 * skips argon2 entirely (SEC-1) — see that module for the security rationale.
 */
export async function verifyApiKey(
  pool: Pool,
  rawKey: string,
): Promise<TenantCtx | null> {
  const match = KEY_REGEX.exec(rawKey);
  if (!match) return null;
  const apikeyId = `apikey_${match[1]}`;

  // Fast path: a key verified within the TTL skips the memory-hard KDF. Only
  // successful verifications ever populate the cache, so a bad-secret flood
  // neither hits nor pollutes it.
  const cached = apiKeyCache.get(apikeyId, rawKey);
  if (cached) {
    bumpLastUsed(pool, apikeyId);
    return cached;
  }

  const { rows } = await query<{
    tenant_id: string;
    key_hash: string;
    revoked_at: Date | null;
    scopes: string[] | null;
  }>(
    pool,
    `SELECT tenant_id, key_hash, revoked_at, scopes FROM api_keys WHERE id = $1`,
    [apikeyId],
  );
  const row = rows[0];
  if (!row || row.revoked_at) {
    // Equalize timing with the live-key path so an unknown/revoked id is not
    // measurably faster than a real one (SEC-14). The decoy verify always fails;
    // its result is discarded.
    await argon2.verify(await decoyHash(), rawKey).catch(() => {});
    return null;
  }
  const ok = await argon2.verify(row.key_hash, rawKey);
  if (!ok) return null;
  // Thread the key's scopes into the ctx so the requireScope route guard (R0.1)
  // can enforce them. A key with no stored scopes resolves to `[]` (no scopes →
  // denied everywhere the guard runs).
  const ctx: TenantCtx = {
    tenantId: row.tenant_id,
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
  };
  apiKeyCache.set(apikeyId, rawKey, ctx);
  bumpLastUsed(pool, apikeyId);
  return ctx;
}
