/**
 * Bearer-auth middleware (§"Authentication").
 *
 * A Fastify `onRequest` hook that reads `Authorization: Bearer <key>`, calls
 * {@link verifyApiKey} to resolve the key → {@link TenantCtx}, and attaches it
 * to `request.tenantCtx`. Missing/invalid credentials throw {@link ApiError}
 * (`401 unauthorized`), mapped to the wire {@link ErrorEnvelope} by the global
 * handler in `server.ts`.
 *
 * Public paths ({@link PUBLIC_PATHS}) bypass auth so liveness/readiness probes
 * work unauthenticated. The hook is registered globally (root-level) so every
 * `/v1/*` route is protected by default.
 *
 * The hook also runs a per-source failed-auth throttle (SEC-1) *before*
 * {@link verifyApiKey}: repeated bad-secret attempts from one IP are rejected
 * without reaching the memory-hard argon2 KDF. This has to live in the
 * `onRequest` auth hook — the `preHandler` rate limiter runs too late to stop a
 * flood of `<live key id> + garbage secret` requests, each of which would
 * otherwise force a full argon2 verify before the limiter ever sees it.
 */

import type { FastifyRequest, FastifyReply } from "fastify";
import { type Pool, type TenantCtx } from "../../infra/db/index.js";
import { verifyApiKey } from "../../domain/tenant/api-key.js";
import { ApiError } from "../../domain/errors.js";

/** Paths that skip authentication (liveness + readiness probes + the public sign-up route). */
export const PUBLIC_PATHS = new Set<string>([
  "/healthz",
  "/readyz",
  "/v1/onboarding/signup",
]);

// Augment FastifyRequest with the resolved tenant context (available to every
// route handler after this hook runs).
declare module "fastify" {
  interface FastifyRequest {
    tenantCtx?: TenantCtx;
  }
}

/** A Fastify onRequest hook that authenticates a bearer token → TenantCtx. */
export type AuthHook = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;

/** Max failed auth attempts tolerated from one source per {@link DEFAULT_FAIL_WINDOW_MS}. */
const DEFAULT_MAX_FAILURES = 10;
/** Sliding window over which failed auth attempts are counted per source. */
const DEFAULT_FAIL_WINDOW_MS = 10_000;

interface FailureRecord {
  count: number;
  /** Epoch ms at which this source's window resets and the count is cleared. */
  resetAt: number;
}

export interface FailedAuthThrottleOptions {
  /** Failures per window before a source is blocked. Default 10. */
  maxFailures?: number;
  /** Window length in ms. Default 10s. */
  windowMs?: number;
  /** Clock source (injectable for deterministic tests). Default `Date.now`. */
  now?: () => number;
}

/**
 * Per-source failed-auth throttle (SEC-1). Bounds how many failed bearer-key
 * attempts one IP can make per window, so a bad-secret flood cannot keep forcing
 * the memory-hard argon2 verify inside {@link verifyApiKey}. Blocked attempts are
 * rejected in the `onRequest` hook, before verification runs.
 *
 * Per-process and keyed on `req.ip`: a caller rotating source IPs can evade it
 * (an inherent limit of per-IP throttling), but each fresh IP only buys
 * `maxFailures` argon2 verifies per window. Records expire on their window and
 * are swept opportunistically, so the map stays bounded.
 */
export class FailedAuthThrottle {
  private readonly failures = new Map<string, FailureRecord>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private lastSweep = 0;

  constructor(opts: FailedAuthThrottleOptions = {}) {
    this.maxFailures = opts.maxFailures ?? DEFAULT_MAX_FAILURES;
    this.windowMs = opts.windowMs ?? DEFAULT_FAIL_WINDOW_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Drop expired records, at most once per window, to keep the map bounded. */
  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [ip, rec] of this.failures) {
      if (now >= rec.resetAt) this.failures.delete(ip);
    }
  }

  /** Whether `ip` has exhausted its failed-auth allowance in the current window. */
  isBlocked(ip: string): boolean {
    const rec = this.failures.get(ip);
    if (!rec) return false;
    if (this.now() >= rec.resetAt) {
      this.failures.delete(ip);
      return false;
    }
    return rec.count >= this.maxFailures;
  }

  /** Record one failed auth attempt for `ip`. */
  recordFailure(ip: string): void {
    const now = this.now();
    this.sweep(now);
    const rec = this.failures.get(ip);
    if (!rec || now >= rec.resetAt) {
      this.failures.set(ip, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    rec.count += 1;
  }

  /** Clear `ip`'s failure record after a successful auth. */
  recordSuccess(ip: string): void {
    this.failures.delete(ip);
  }

  /** Live record count (introspection for tests / bounds). */
  size(): number {
    return this.failures.size;
  }
}

/**
 * Build the auth hook bound to a DB pool. The pool is required: auth resolves a
 * key by reading its argon2id hash from `api_keys`. One {@link
 * FailedAuthThrottle} is created per handler (i.e. per app instance).
 */
export function createAuthHandler(pool: Pool): AuthHook {
  const throttle = new FailedAuthThrottle();
  return async function authHandler(req, _reply): Promise<void> {
    if (PUBLIC_PATHS.has(req.url)) return;
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      throw new ApiError(401, "unauthorized", "missing or invalid Authorization header");
    }
    const rawKey = header.slice("Bearer ".length).trim();
    if (!rawKey) {
      throw new ApiError(401, "unauthorized", "missing API key");
    }
    // Reject sources over their failed-auth budget before running argon2 (SEC-1).
    if (throttle.isBlocked(req.ip)) {
      throw new ApiError(401, "unauthorized", "too many failed authentication attempts");
    }
    const ctx = await verifyApiKey(pool, rawKey);
    if (!ctx) {
      throttle.recordFailure(req.ip);
      throw new ApiError(401, "unauthorized", "invalid or revoked API key");
    }
    throttle.recordSuccess(req.ip);
    req.tenantCtx = ctx;
  };
}
