/**
 * API-key scope enforcement (R0.1, §8 — "scopes").
 *
 * `verifyApiKey` resolves a key → {@link TenantCtx} carrying the key's `scopes`;
 * this module turns those scopes into a route guard. Without it every key is
 * effectively tenant-admin (the pre-R0.1 state: scopes were stored and returned
 * but no route checked them).
 *
 * Scope model:
 * - `admin` is a wildcard — it satisfies every requirement.
 * - Any other scope matches only itself (exact match). In particular a
 *   `self_hosted_worker:<envId>` scope satisfies NONE of `read`/`write`/`admin`,
 *   so a self-hosted worker key is denied on every route that carries a scope
 *   guard (R0.2 — worker keys are deny-by-default; the 3 work-queue routes carry
 *   no guard and enforce their own env binding instead).
 *
 * Wiring convention (see the route plugins): a plugin-level `preHandler` guard —
 * {@link requireScopeByMethod} — maps `GET`/`HEAD` → `read` and every mutating
 * method → `write`. {@link requireScope} is the explicit building block for
 * routes that need a fixed scope regardless of method.
 */

import type { FastifyRequest, FastifyReply } from "fastify";
import type { TenantCtx } from "../../infra/db/index.js";
import { ApiError } from "../../domain/errors.js";

/** The wildcard scope: an `admin` ctx satisfies every requirement. */
const ADMIN_SCOPE = "admin";

/**
 * True when `ctx` holds `required`. `admin` is a wildcard that implies every
 * scope; every other scope matches only itself (so `self_hosted_worker:<envId>`
 * satisfies none of `read`/`write`/`admin`). A ctx with no scopes holds nothing.
 */
export function hasScope(ctx: TenantCtx, required: string): boolean {
  const scopes = ctx.scopes ?? [];
  if (scopes.includes(ADMIN_SCOPE)) return true;
  return scopes.includes(required);
}

/** Map an HTTP method to the scope its route requires (`read` vs `write`). */
export function scopeForMethod(method: string): "read" | "write" {
  return method === "GET" || method === "HEAD" ? "read" : "write";
}

/**
 * Build a Fastify `preHandler` that requires the ctx to hold at least one of
 * `required` (an `admin` ctx always passes). Throws `403 forbidden` otherwise
 * (and `401` if no tenant ctx is attached, which should not happen behind the
 * auth hook). Use for routes whose required scope is fixed regardless of method.
 */
export function requireScope(
  ...required: string[]
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async function scopeGuard(req: FastifyRequest): Promise<void> {
    const ctx = req.tenantCtx;
    if (!ctx) {
      throw new ApiError(401, "unauthorized", "missing tenant context");
    }
    if (!required.some((r) => hasScope(ctx, r))) {
      throw new ApiError(
        403,
        "forbidden",
        `missing required scope: ${required.join(" or ")}`,
      );
    }
  };
}

/**
 * A plugin-level `preHandler` that enforces the method→scope convention:
 * `GET`/`HEAD` require `read`, every mutating method requires `write` (an
 * `admin` ctx passes all). Register once per route plugin
 * (`app.addHook("preHandler", requireScopeByMethod)`) to guard all of its
 * routes; routes with bespoke auth (the self-hosted work-queue surface) opt out
 * by not registering it.
 */
export async function requireScopeByMethod(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const ctx = req.tenantCtx;
  if (!ctx) {
    throw new ApiError(401, "unauthorized", "missing tenant context");
  }
  const required = scopeForMethod(req.method);
  if (!hasScope(ctx, required)) {
    throw new ApiError(403, "forbidden", `missing required scope: ${required}`);
  }
}
