/**
 * Per-tenant + per-IP rate-limiting middleware (WP-P0.5, WP-R0.8, WP-R0.5).
 *
 * Implements api-reference.md §"Rate limiting":
 * - Token bucket (spec §27.3) keyed by `request.tenantCtx.tenantId` for
 *   authenticated requests. Unauthenticated requests (the auth allowlist:
 *   `/healthz`, `/readyz`, and the public `POST /v1/onboarding/signup`, which
 *   creates a tenant + runs an expensive argon2id hash per call) fall back to a
 *   bucket keyed by the client IP with a much smaller capacity (`anonRpm`).
 * - Exhausted bucket → `429` + `Retry-After` (seconds) header + error envelope
 *   with `code: rate_limited`.
 * - Every response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and
 *   `X-RateLimit-Reset` (unix seconds).
 * - Idle buckets are swept/reaped on a TTL so the store stays bounded.
 *
 * The client IP is the peer address (`request.ip`). `X-Forwarded-For` is honoured
 * ONLY when the peer is in the configured `trustedProxies` list — otherwise any
 * caller could rotate the header and bypass the limit entirely.
 *
 * Limits (`rpm` / `anonRpm`) and `trustedProxies` are wired from {@link Config}
 * by the composition root (server.ts) — the caller passes config-driven values.
 *
 * The bucket store is pluggable ({@link BucketStore}):
 * - {@link InMemoryBucketStore} — a per-process `Map`. Simple, but N replicas
 *   allow up to N× the intended ceiling (the buckets are not shared).
 * - {@link PostgresBucketStore} — a shared table so the ceiling is GLOBAL across
 *   replicas. The token refill + decrement is a single atomic
 *   `INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING`, so concurrent nodes
 *   serialize on the row lock and cannot each mint a fresh full bucket.
 *
 * Select the store via `config.rateLimitStore` (see {@link createBucketStore}).
 * (Fully-atomic per-request concurrency correctness — e.g. eliminating the tiny
 * read/refill window entirely — is R5's remit; this delivers the global ceiling
 * + config-wiring.)
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ErrorEnvelope } from "@pi-managed/contracts";
import { query, type Pool, type TenantCtx } from "../../infra/db/index.js";

/** Default capacity (requests/min) for an authenticated tenant. */
const DEFAULT_RPM = 600;
/** Default capacity (requests/min) for a single unauthenticated client IP. */
const DEFAULT_ANON_RPM = 30;
/**
 * Evict a bucket after this long without a request. A bucket refills to capacity
 * in 60s regardless of `rpm`, so dropping one that has been idle longer is
 * equivalent to re-creating it full on the next request — eviction is free.
 */
const DEFAULT_BUCKET_TTL_MS = 120_000;
/** Minimum wall-clock gap between two sweeps of the bucket store. */
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/** Milliseconds in a minute — a bucket refills its full capacity over this span. */
const MS_PER_MINUTE = 60_000;

/** Refill rate (tokens/ms) for a bucket of the given capacity (per minute). */
function refillPerMsFor(capacity: number): number {
  return capacity / MS_PER_MINUTE;
}

// ---------------------------------------------------------------------------
// Bucket store abstraction
// ---------------------------------------------------------------------------

/** Outcome of attempting to consume one token from a bucket. */
export interface ConsumeResult {
  /** Whether a token was available (and consumed). */
  allowed: boolean;
  /** Tokens remaining after this attempt (fractional; post-decrement when allowed). */
  tokens: number;
  /** The bucket's capacity (requests/min). */
  capacity: number;
  /** The bucket's refill rate (tokens/ms). */
  refillPerMs: number;
}

/**
 * Pluggable backing store for rate-limit token buckets. Implementations own
 * refill, decrement, and eviction; the middleware only asks to consume a token.
 */
export interface BucketStore {
  /**
   * Atomically refill + attempt to consume one token from the bucket `key`
   * (creating it full at `capacity` if absent). Returns the post-attempt state.
   */
  consume(key: string, capacity: number): Promise<ConsumeResult> | ConsumeResult;
  /** Number of live buckets currently held (introspection for tests / bounds). */
  size(): number | Promise<number>;
  /** Release any timers/handles held by the store (reaper interval, etc.). */
  close(): void | Promise<void>;
}

interface MemoryBucket {
  tokens: number;
  capacity: number;
  refillPerMs: number;
  lastRefillMs: number;
}

export interface InMemoryBucketStoreOptions {
  /** Idle time after which a bucket is evicted. Default 120s. */
  bucketTtlMs?: number;
  /** Minimum gap between sweeps of the bucket map. Default 60s. */
  sweepIntervalMs?: number;
}

/**
 * Per-process token-bucket store backed by a `Map`. Idle buckets are evicted on
 * a TTL (swept at most once per `sweepIntervalMs`) so the map stays bounded.
 * Per-process: N replicas allow up to N× the ceiling — use
 * {@link PostgresBucketStore} for a global limit.
 */
export class InMemoryBucketStore implements BucketStore {
  private readonly buckets = new Map<string, MemoryBucket>();
  private readonly bucketTtlMs: number;
  private readonly sweepIntervalMs: number;
  private lastSweepMs = 0;

  constructor(opts: InMemoryBucketStoreOptions = {}) {
    this.bucketTtlMs = opts.bucketTtlMs ?? DEFAULT_BUCKET_TTL_MS;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  }

  /** Drop buckets idle for longer than the TTL, at most once per sweep interval. */
  private sweep(now: number): void {
    if (now - this.lastSweepMs < this.sweepIntervalMs) return;
    this.lastSweepMs = now;
    for (const [key, b] of this.buckets) {
      if (now - b.lastRefillMs > this.bucketTtlMs) this.buckets.delete(key);
    }
  }

  consume(key: string, capacity: number): ConsumeResult {
    const now = Date.now();
    this.sweep(now);
    let b = this.buckets.get(key);
    if (!b) {
      b = {
        tokens: capacity,
        capacity,
        refillPerMs: refillPerMsFor(capacity),
        lastRefillMs: now,
      };
      this.buckets.set(key, b);
    } else {
      const elapsed = now - b.lastRefillMs;
      if (elapsed > 0) {
        b.tokens = Math.min(b.capacity, b.tokens + elapsed * b.refillPerMs);
        b.lastRefillMs = now;
      }
    }
    if (b.tokens < 1) {
      return { allowed: false, tokens: b.tokens, capacity: b.capacity, refillPerMs: b.refillPerMs };
    }
    b.tokens -= 1;
    return { allowed: true, tokens: b.tokens, capacity: b.capacity, refillPerMs: b.refillPerMs };
  }

  size(): number {
    return this.buckets.size;
  }

  close(): void {
    this.buckets.clear();
  }
}

interface BucketRow {
  tokens: number | string;
  capacity: number | string;
  refill_per_ms: number | string;
  allowed: boolean;
}

export interface PostgresBucketStoreOptions {
  /** Idle time after which a bucket row is reaped. Default 120s. */
  bucketTtlMs?: number;
  /** Interval between reaper passes. Default 60s. `0` disables the reaper. */
  reapIntervalMs?: number;
}

/**
 * Shared token-bucket store backed by the `rate_limit_buckets` table
 * (migration 027) so the limit ceiling is GLOBAL across replicas.
 *
 * The refill + decrement is one atomic statement:
 * `INSERT ... ON CONFLICT (key) DO UPDATE ... RETURNING`. On a fresh key the row
 * is inserted with `capacity - 1` tokens (the first request consumes one); on a
 * conflict the existing row is refilled by the elapsed time then decremented iff
 * ≥ 1 token is available. Concurrent consumers on the same key serialize on the
 * row lock (READ COMMITTED re-reads the latest committed row for the conflict),
 * so two nodes cannot each start from a full bucket.
 *
 * A background reaper deletes rows idle past the TTL so the table stays bounded.
 */
export class PostgresBucketStore implements BucketStore {
  private readonly pool: Pool;
  private readonly bucketTtlMs: number;
  private readonly reaper?: ReturnType<typeof setInterval>;

  constructor(pool: Pool, opts: PostgresBucketStoreOptions = {}) {
    this.pool = pool;
    this.bucketTtlMs = opts.bucketTtlMs ?? DEFAULT_BUCKET_TTL_MS;
    const reapIntervalMs = opts.reapIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    if (reapIntervalMs > 0) {
      this.reaper = setInterval(() => {
        void this.reap();
      }, reapIntervalMs);
      // Do not keep the event loop alive solely for the reaper.
      this.reaper.unref?.();
    }
  }

  async consume(key: string, capacity: number): Promise<ConsumeResult> {
    const now = Date.now();
    const refillPerMs = refillPerMsFor(capacity);
    // `refilled` (the tokens available after time-based refill, capped at
    // capacity) is computed from the OLD row values (`b.*`) inside DO UPDATE.
    // We decrement iff refilled >= 1 and record the outcome in `allowed` so the
    // caller learns it from the same atomic statement.
    const refilled =
      "LEAST(b.capacity, b.tokens + GREATEST(0, $4 - b.last_refill_ms) * b.refill_per_ms)";
    const { rows } = await query<BucketRow>(
      this.pool,
      `INSERT INTO rate_limit_buckets AS b
         (key, tokens, capacity, refill_per_ms, allowed, last_refill_ms, updated_at)
       VALUES ($1, $2 - 1, $2, $3, true, $4, now())
       ON CONFLICT (key) DO UPDATE SET
         tokens = CASE WHEN ${refilled} >= 1 THEN ${refilled} - 1 ELSE ${refilled} END,
         allowed = (${refilled} >= 1),
         capacity = EXCLUDED.capacity,
         refill_per_ms = EXCLUDED.refill_per_ms,
         last_refill_ms = $4,
         updated_at = now()
       RETURNING b.tokens AS tokens, b.capacity AS capacity,
                 b.refill_per_ms AS refill_per_ms, b.allowed AS allowed`,
      [key, capacity, refillPerMs, now],
    );
    const row = rows[0]!;
    return {
      allowed: row.allowed,
      tokens: Number(row.tokens),
      capacity: Number(row.capacity),
      refillPerMs: Number(row.refill_per_ms),
    };
  }

  /** Delete buckets idle past the TTL. */
  async reap(): Promise<number> {
    const cutoff = Date.now() - this.bucketTtlMs;
    const { rowCount } = await query(
      this.pool,
      `DELETE FROM rate_limit_buckets WHERE last_refill_ms < $1`,
      [cutoff],
    );
    return rowCount ?? 0;
  }

  async size(): Promise<number> {
    const { rows } = await query<{ n: string }>(
      this.pool,
      `SELECT count(*)::text AS n FROM rate_limit_buckets`,
      [],
    );
    return Number(rows[0]!.n);
  }

  close(): void {
    if (this.reaper) clearInterval(this.reaper);
  }
}

/**
 * Build the bucket store selected by config. `postgres` requires a `pool`.
 */
export function createBucketStore(
  opts: {
    store: "memory" | "postgres";
    pool?: Pool;
    bucketTtlMs?: number;
    sweepIntervalMs?: number;
  },
): BucketStore {
  if (opts.store === "postgres") {
    if (!opts.pool) {
      throw new Error(
        "rate-limit: RATE_LIMIT_STORE=postgres requires a database pool (config.dbUrl).",
      );
    }
    return new PostgresBucketStore(opts.pool, {
      bucketTtlMs: opts.bucketTtlMs,
      reapIntervalMs: opts.sweepIntervalMs,
    });
  }
  return new InMemoryBucketStore({
    bucketTtlMs: opts.bucketTtlMs,
    sweepIntervalMs: opts.sweepIntervalMs,
  });
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export interface RateLimitOptions {
  /** Per-tenant bucket capacity + refill rate, in requests-per-minute. Default 600. */
  rpm?: number;
  /** Per-IP capacity for unauthenticated requests, in requests-per-minute. Default 30. */
  anonRpm?: number;
  /** Peer IPs whose `X-Forwarded-For` header is trusted. Default: none. */
  trustedProxies?: string[];
  /**
   * Backing store for buckets. Defaults to a fresh {@link InMemoryBucketStore}
   * built from `bucketTtlMs`/`sweepIntervalMs`. Pass a shared
   * {@link PostgresBucketStore} for a global (cross-replica) ceiling.
   */
  store?: BucketStore;
  /** Idle time after which a bucket is evicted (in-memory default store). Default 120s. */
  bucketTtlMs?: number;
  /** Minimum gap between sweeps (in-memory default store). Default 60s. */
  sweepIntervalMs?: number;
}

/** Handle returned by {@link rateLimitMiddleware} (introspection for tests). */
export interface RateLimiter {
  /** Number of live buckets currently held (delegates to the store). */
  bucketCount(): number | Promise<number>;
  /** The backing store (so a caller that did not inject one can close it). */
  store: BucketStore;
}

/** Augment FastifyRequest with the optional tenant context (merged with P0.4). */
declare module "fastify" {
  interface FastifyRequest {
    tenantCtx?: TenantCtx;
  }
}

/**
 * Install the rate-limit hooks on `app`. Attached directly to the instance
 * (not an encapsulated plugin) so the bucket check applies to every route.
 */
export function rateLimitMiddleware(
  app: FastifyInstance,
  opts: RateLimitOptions = {},
): RateLimiter {
  const rpm = opts.rpm ?? DEFAULT_RPM;
  const anonRpm = opts.anonRpm ?? DEFAULT_ANON_RPM;
  const trustedProxies = new Set(opts.trustedProxies ?? []);
  const store =
    opts.store ??
    new InMemoryBucketStore({
      bucketTtlMs: opts.bucketTtlMs,
      sweepIntervalMs: opts.sweepIntervalMs,
    });

  /**
   * The client IP to key an anonymous bucket on. `X-Forwarded-For` is a chain of
   * `client, proxy1, proxy2`; only the entries appended by trusted proxies can be
   * believed, so we walk it right-to-left and take the first hop that is not
   * itself a trusted proxy. An untrusted peer's header is ignored outright.
   */
  function clientIp(req: FastifyRequest): string {
    const peer = req.ip;
    if (!trustedProxies.has(peer)) return peer;
    const header = req.headers["x-forwarded-for"];
    const raw = Array.isArray(header) ? header.join(",") : header;
    if (!raw) return peer;
    const hops = raw.split(",").map((h) => h.trim()).filter((h) => h.length > 0);
    for (let i = hops.length - 1; i >= 0; i--) {
      const hop = hops[i]!;
      if (!trustedProxies.has(hop)) return hop;
    }
    return peer;
  }

  app.addHook(
    "preHandler",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const tenantCtx = req.tenantCtx;
      const { key, capacity: requestedCapacity } = tenantCtx
        ? { key: `tenant:${tenantCtx.tenantId}`, capacity: rpm }
        : { key: `ip:${clientIp(req)}`, capacity: anonRpm };

      const result = await store.consume(key, requestedCapacity);
      const { capacity, refillPerMs, tokens } = result;

      const setRateHeaders = (remaining: number, resetInSec: number): void => {
        reply.header("X-RateLimit-Limit", String(capacity));
        reply.header("X-RateLimit-Remaining", String(Math.max(0, Math.floor(remaining))));
        reply.header(
          "X-RateLimit-Reset",
          String(Math.floor(Date.now() / 1000) + Math.max(0, Math.ceil(resetInSec))),
        );
      };

      if (!result.allowed) {
        // Exhausted: compute retry-after (time until 1 token refills).
        const retryAfterSec = Math.ceil((1 - tokens) / refillPerMs / 1000);
        const resetInSec = (capacity - tokens) / refillPerMs / 1000;
        setRateHeaders(tokens, resetInSec);
        reply.header("Retry-After", String(Math.max(1, retryAfterSec)));
        const env: ErrorEnvelope = {
          error: {
            type: "rate_limited",
            code: "rate_limited",
            message: tenantCtx
              ? "Tenant rate limit exceeded."
              : "Rate limit exceeded for this client address.",
            requestId: req.id,
          },
        };
        return reply.status(429).send(env);
      }

      const resetInSec = (capacity - tokens) / refillPerMs / 1000;
      setRateHeaders(tokens, resetInSec);
    },
  );

  return {
    bucketCount: () => store.size(),
    store,
  };
}
