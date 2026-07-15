/**
 * Tenant / admin routes (§"Tenant / admin").
 *
 * - `GET /v1/tenant` — current tenant info + a zeroed quota-usage stub (§27.3
 *   rollups land in a later WP).
 * - `POST /v1/api-keys` — issue a key (`Idempotency-Key` required); raw key
 *   shown once.
 * - `GET /v1/api-keys` — list keys (no raw key).
 * - `DELETE /v1/api-keys/:id` — revoke; `204` on success, `404` if absent
 *   (or in another tenant — same response to avoid leakage).
 *
 * All routes rely on the auth middleware having set `request.tenantCtx`.
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { requireScopeByMethod } from "./middleware/scope.js";
import { type Pool } from "../infra/db/index.js";
import { ApiError } from "../domain/errors.js";
import { getTenant } from "../domain/tenant/tenant.js";
import { issueApiKey, listApiKeys, revokeApiKey } from "../domain/tenant/api-key.js";
import { getCurrentUsage, getQuotaPlanForTenant } from "../domain/quota/index.js";
import { ApiKeyCreate } from "@pi-managed/contracts";

export interface TenantRoutesOptions {
  pool: Pool;
}

/** Resolve the authenticated tenant context or throw 401. */
function requireCtx(req: FastifyRequest) {
  const ctx = req.tenantCtx;
  if (!ctx) {
    throw new ApiError(401, "unauthorized", "missing tenant context");
  }
  return ctx;
}

export const tenantRoutes: FastifyPluginAsync<TenantRoutesOptions> = async (
  app,
  opts,
) => {
  // R0.1: enforce API-key scopes on every route in this plugin (GET/HEAD → read,
  // mutating → write; `admin` passes all; worker keys are denied here). Note the
  // signup bootstrap key is `["admin"]`, so it can mint further keys; a `read`
  // key cannot.
  app.addHook("preHandler", requireScopeByMethod);
  // GET /v1/tenant — current tenant info + real quota usage vs plan limits
  // (§27.3, WP-4.4). `quotaUsage` is the live rollup from Postgres; `quotaLimits`
  // is the active plan envelope so clients can show usage vs limits.
  app.get("/v1/tenant", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    const tenant = await getTenant(opts.pool, ctx.tenantId);
    if (!tenant) {
      throw new ApiError(404, "not_found", "tenant not found");
    }
    const [plan, usage] = await Promise.all([
      getQuotaPlanForTenant(opts.pool, ctx.tenantId),
      getCurrentUsage(opts.pool, ctx.tenantId),
    ]);
    // `tokenSpendUsd` is the month-to-date rollup from usage_records (WP-1.10,
    // §9.7) — matches the `monthlyTokenSpendUsd` plan dimension.
    return reply.status(200).send({
      tenantId: tenant.id,
      name: tenant.name,
      quotaPlan: tenant.quotaPlan ?? "default",
      quotaUsage: usage,
      quotaLimits: plan,
    });
  });

  // POST /v1/api-keys — issue a key (Idempotency-Key required; raw key shown once).
  // `idempotencyNoStore` opts this route out of response-body capture: the raw
  // `pmb_live_` key must never be persisted in idempotency_keys (§25.1, §8).
  app.post(
    "/v1/api-keys",
    { config: { idempotencyNoStore: true } },
    async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    const idempotencyKey = req.headers["idempotency-key"];
    if (
      !idempotencyKey ||
      typeof idempotencyKey !== "string" ||
      idempotencyKey.trim() === ""
    ) {
      throw new ApiError(400, "invalid_request", "Idempotency-Key header is required");
    }
    const parsed = ApiKeyCreate.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(
        422,
        "invalid_request",
        `invalid request body: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      );
    }
    // R0.1: new keys default to least privilege (`read`) when no scopes are
    // requested — an admin key must opt in explicitly (e.g. `scopes: ["admin"]`).
    // The signup bootstrap key is minted as `["admin"]` in the onboarding path.
    const issued = await issueApiKey(opts.pool, ctx, {
      ...parsed.data,
      scopes: parsed.data.scopes ?? ["read"],
    });
    return reply.status(201).send(issued);
    },
  );

  // GET /v1/api-keys — list keys (no raw key).
  app.get("/v1/api-keys", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    const data = await listApiKeys(opts.pool, ctx);
    return reply.status(200).send({ data, nextCursor: null });
  });

  // DELETE /v1/api-keys/:id — revoke (204); 404 if absent / wrong tenant.
  app.delete(
    "/v1/api-keys/:id",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(req);
      const { id } = req.params as { id: string };
      const ok = await revokeApiKey(opts.pool, ctx, id);
      if (!ok) {
        throw new ApiError(404, "not_found", `api key not found: ${id}`);
      }
      return reply.status(204).send();
    },
  );
};
