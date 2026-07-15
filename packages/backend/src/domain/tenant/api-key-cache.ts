/**
 * Verified-API-key cache (SEC-1).
 *
 * A per-process cache of *successfully verified* raw keys → {@link TenantCtx}
 * with a short TTL. On a cache hit {@link verifyApiKey} skips the memory-hard
 * argon2id verification entirely, comparing the raw key's sha256 digest in
 * constant time instead. This removes argon2 from the steady-state authenticated
 * hot path — fixing both the per-request throughput ceiling and the DoS
 * amplification where a live key would otherwise force a ~64MiB KDF per request.
 *
 * Security notes:
 * - Only a *successful* verification populates the cache, so a flood of bad
 *   secrets can neither land a cache hit nor displace real entries — the map is
 *   bounded by the number of genuinely valid keys, which an attacker cannot
 *   grow. No active sweep is needed; expired entries are dropped lazily on read.
 * - The lookup compares full sha256 digests with {@link timingSafeEqual} so a
 *   cache probe leaks no timing signal about the stored secret.
 * - The cache is per-process: after {@link revokeApiKey} invalidates an entry,
 *   revocation is immediate on this instance but other replicas keep serving the
 *   key until their own cached entry expires — cross-instance revocation latency
 *   is bounded by {@link ApiKeyCache}'s TTL.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { TenantCtx } from "../../infra/db/index.js";

/** Default entry lifetime. Bounds cross-replica revocation latency. */
const DEFAULT_TTL_MS = 60_000;

interface CacheEntry {
  /** sha256(rawKey) as a 32-byte buffer, for constant-time comparison. */
  digest: Buffer;
  ctx: TenantCtx;
  /** Epoch ms after which the entry is stale and must not be served. */
  expiresAt: number;
}

function sha256(raw: string): Buffer {
  return createHash("sha256").update(raw).digest();
}

/** A fresh copy of `ctx` so cached state can never be mutated by a caller. */
function cloneCtx(ctx: TenantCtx): TenantCtx {
  return { tenantId: ctx.tenantId, scopes: ctx.scopes ? [...ctx.scopes] : undefined };
}

export interface ApiKeyCacheOptions {
  /** Entry lifetime in ms. Default 60s. */
  ttlMs?: number;
  /** Clock source (injectable for deterministic tests). Default `Date.now`. */
  now?: () => number;
}

/**
 * Per-process cache keyed by api-key id. Each entry pins the sha256 of the raw
 * key it was verified against, so a different secret for the same id never hits.
 */
export class ApiKeyCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: ApiKeyCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Return a fresh {@link TenantCtx} iff a non-expired entry for `apikeyId`
   * exists whose digest matches sha256(`rawKey`) in constant time. Otherwise
   * `null` — the caller must fall back to the argon2 verification of record.
   */
  get(apikeyId: string, rawKey: string): TenantCtx | null {
    const entry = this.entries.get(apikeyId);
    if (!entry) return null;
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(apikeyId);
      return null;
    }
    // Both operands are fixed 32-byte sha256 digests, so lengths always match.
    if (!timingSafeEqual(sha256(rawKey), entry.digest)) return null;
    return cloneCtx(entry.ctx);
  }

  /** Cache a successful verification: sha256(`rawKey`) → `ctx` for the TTL. */
  set(apikeyId: string, rawKey: string, ctx: TenantCtx): void {
    this.entries.set(apikeyId, {
      digest: sha256(rawKey),
      ctx: cloneCtx(ctx),
      expiresAt: this.now() + this.ttlMs,
    });
  }

  /** Drop any cached entry for `apikeyId` (called on revoke). */
  invalidate(apikeyId: string): void {
    this.entries.delete(apikeyId);
  }

  /** Live entry count (introspection for tests / bounds). */
  size(): number {
    return this.entries.size;
  }
}

/** Process-wide verified-key cache shared by verifyApiKey + revokeApiKey. */
export const apiKeyCache = new ApiKeyCache();
