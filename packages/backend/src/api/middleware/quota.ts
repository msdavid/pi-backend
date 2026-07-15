/**
 * Quota enforcement middleware (WP-4.4, §27.3).
 *
 * A Fastify `preHandler` that maps mutating `POST`s to the quota resource they
 * consume and calls {@link checkQuota} before the handler runs. On exceed →
 * `429` + `code: rate_limited` (api-reference §"Rate limiting": quota-exceeded
 * conditions share the rate-limited status). Every checked response carries
 * `X-Quota-Limit` + `X-Quota-Remaining` for the relevant dimension.
 *
 * Route → resource mapping (resource-creating endpoints only):
 *   POST /v1/files                          → maxFileStorageBytes (Content-Length)
 *
 * R5.2/ROB-15: the count-based dimensions (`concurrentSessions`, `maxJobs`,
 * `maxVaultCredentials`, `maxMemoryStores`) and now the amount-based ones
 * (`maxFileStorageBytes`, `monthlyTokenSpendUsd`) are enforced by an atomic
 * `tenant_quota_counters` reservation INSIDE the create transaction of their
 * owning domain module — `reserveQuota` for counts, `reserveQuotaDelta` for
 * amounts — with the matching release on delete (session-repo `deleteSession`,
 * scheduler `archiveJob`, vault `archiveCredential`, memory `deleteMemoryStore`,
 * file `deleteFile`). A pre-flight `SUM`/COUNT is racy (N concurrent creates all
 * read the same under-limit total and all pass); the row lock admits exactly up
 * to `limit`. The authoritative file-storage reservation is `reserveQuotaDelta`
 * in `domain/file` `uploadFile` (real buffered bytes, transactional with the
 * `files` insert, so it composes with idempotency replay) — NOT a middleware
 * reserve, which would only see `Content-Length` (an over-count) and would not
 * compose with idempotency.
 *
 * This file-storage pre-flight is retained as a cheap, fail-closed early
 * rejection (a single-dimension {@link checkQuota}, PERF-7) so an obviously
 * over-quota upload is refused before its body is buffered; it is defense in
 * depth in front of the authoritative reserve, not the guarantee. Residual
 * counter drift (the `Content-Length` over-count never applies here; crash
 * leaks / missed releases do) is corrected by `reconcileQuotaCounter`.
 *
 * Token-spend enforcement (`monthlyTokenSpendUsd`) is NOT wired here — model
 * requests are not HTTP `POST`s exposed by this surface; `reserveQuotaDelta`
 * (or the pre-flight {@link checkQuota}) is invoked from the usage recorder /
 * budget path (WP-1.10).
 *
 * Registered globally (root-level) like the P0.5 rate-limit middleware; no-ops
 * when `request.tenantCtx` is absent (unauthenticated / public paths).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ErrorEnvelope } from "@pi-managed/contracts";
import type { Pool } from "../../infra/db/index.js";
import { checkQuota, type QuotaResource } from "../../domain/quota/index.js";

/** A route → resource binding. */
interface QuotaRoute {
  /** Matches `request.url` (path only). */
  pattern: RegExp;
  resource: QuotaResource;
  /** Optional delta extractor (e.g. upload size from Content-Length). */
  delta?: (req: FastifyRequest) => number | undefined;
}

/**
 * Route table. Exact-match patterns (`^…$`) ensure sub-paths are NOT matched:
 * `POST /v1/sessions/:id/events` must NOT trigger a concurrent-sessions check.
 */
const ROUTES: QuotaRoute[] = [
  {
    pattern: /^\/v1\/files$/,
    resource: "maxFileStorageBytes",
    // Multipart Content-Length over-counts (envelope + boundaries), which is
    // the safe direction for a quota check. Absent header → 0 (skip).
    delta: (req) => {
      const cl = req.headers["content-length"];
      const n = Array.isArray(cl) ? cl[0] : cl;
      const v = n ? Number(n) : NaN;
      return Number.isFinite(v) ? v : undefined;
    },
  },
];

/** Strip the query string; route matching is path-only. */
function pathOf(url: string): string {
  const q = url.indexOf("?");
  return q >= 0 ? url.slice(0, q) : url;
}

/** Match a request to a quota route, or `null` if it is not quota-gated. */
function matchRoute(method: string, url: string): QuotaRoute | null {
  if (method !== "POST") return null;
  const path = pathOf(url);
  return ROUTES.find((r) => r.pattern.test(path)) ?? null;
}

export interface QuotaMiddlewareOptions {
  pool: Pool;
}

/**
 * Install the quota preHandler on `app`. Attached directly to the instance
 * (not an encapsulated plugin) so it applies to every route, mirroring the
 * P0.5 rate-limit middleware.
 */
export function quotaMiddleware(
  app: FastifyInstance,
  opts: QuotaMiddlewareOptions,
): void {
  app.addHook(
    "preHandler",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const route = matchRoute(req.method, req.url);
      if (!route) return;
      const tenantCtx = req.tenantCtx;
      if (!tenantCtx) return; // unauthenticated / public path → no-op.

      const delta = route.delta?.(req);
      const check = await checkQuota(
        opts.pool,
        tenantCtx.tenantId,
        route.resource,
        delta !== undefined && route.resource === "maxFileStorageBytes"
          ? { fileStorageDelta: delta }
          : {},
      );

      reply.header("X-Quota-Limit", String(check.limit));
      reply.header("X-Quota-Resource", check.resource);
      reply.header(
        "X-Quota-Remaining",
        String(Math.max(0, check.limit - check.current)),
      );

      if (check.exceeded) {
        // Quota-exceeded shares the rate-limited status (§"Rate limiting").
        reply.header("Retry-After", "60");
        const env: ErrorEnvelope = {
          error: {
            type: "rate_limited",
            code: "rate_limited",
            message: `Quota exceeded for ${check.resource}: ${check.current}/${check.limit}.`,
            details: {
              resource: check.resource,
              limit: check.limit,
              current: check.current,
            },
            requestId: req.id,
          },
        };
        return reply.status(429).send(env);
      }
    },
  );
}
