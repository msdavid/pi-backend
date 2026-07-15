/**
 * Agents API routes (§"Agents", WP-1.1).
 *
 * - `POST /v1/agents` — create (`Idempotency-Key` required).
 * - `GET /v1/agents` — list (cursor-paginated; `?name=` & `?metadata.k=` filters).
 * - `GET /v1/agents/:id` — retrieve (current-version config expanded).
 * - `PATCH /v1/agents/:id` — update (creates a new immutable version).
 * - `POST /v1/agents/:id/archive` — archive (terminal; `Idempotency-Key` required).
 * - `GET /v1/agents/:id/versions` — list versions.
 * - `GET /v1/agents/:id/versions/:ver` — retrieve a version.
 *
 * Validation is delegated to the `@pi-managed/contracts` zod schemas (re-used
 * inside the domain service). All errors are thrown as {@link ApiError} and
 * mapped to the global {@link ErrorEnvelope} by `server.ts`. Every route relies
 * on the auth middleware having set `request.tenantCtx`.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { requireScopeByMethod } from "./middleware/scope.js";
import { type Pool } from "../infra/db/index.js";
import { ApiError } from "../domain/errors.js";
import {
  createAgent,
  listAgents,
  getAgent,
  updateAgent,
  archiveAgent,
  listVersions,
  getVersion,
} from "../domain/agent/agent.js";
import { parseListParams, paginate } from "../api/middleware/pagination.js";

export interface AgentRoutesOptions {
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

/** Require a non-empty `Idempotency-Key` header (POST endpoints). */
function requireIdempotencyKey(req: FastifyRequest): void {
  const key = req.headers["idempotency-key"];
  if (!key || Array.isArray(key) || String(key).trim() === "") {
    throw new ApiError(400, "invalid_request", "Idempotency-Key header is required");
  }
}

/** Parse `?metadata.<key>=<value>` query params into a record. */
function parseMetadataFilter(query: Record<string, unknown>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) {
    if (k.startsWith("metadata.") && typeof v === "string") {
      out[k.slice("metadata.".length)] = v;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

export const agentRoutes: FastifyPluginAsync<AgentRoutesOptions> = async (app, opts) => {
  // R0.1: enforce API-key scopes on every route in this plugin (GET/HEAD → read,
  // mutating methods → write; an `admin` key passes all). Worker keys (R0.2) are
  // denied here (they hold only `self_hosted_worker:<envId>`).
  app.addHook("preHandler", requireScopeByMethod);
  // POST /v1/agents — create (Idempotency-Key required).
  app.post("/v1/agents", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    requireIdempotencyKey(req);
    const created = await createAgent(opts.pool, ctx, req.body as never);
    return reply.status(201).send(created);
  });

  // GET /v1/agents — list (cursor-paginated).
  app.get("/v1/agents", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    const { limit, cursor } = parseListParams(req);
    const query = (req.query ?? {}) as Record<string, unknown>;
    const name = typeof query.name === "string" ? query.name : undefined;
    const metadata = parseMetadataFilter(query);
    const result = await listAgents(opts.pool, ctx, { limit, cursor, name, metadata });
    return reply.status(200).send(paginate(result.data, result.nextCursor ?? undefined));
  });

  // GET /v1/agents/:id — retrieve.
  app.get("/v1/agents/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    const agent = await getAgent(opts.pool, ctx, id);
    return reply.status(200).send(agent);
  });

  // PATCH /v1/agents/:id — update (creates a new version).
  app.patch("/v1/agents/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    const agent = await updateAgent(opts.pool, ctx, id, req.body as never);
    return reply.status(200).send(agent);
  });

  // POST /v1/agents/:id/archive — archive (terminal; Idempotency-Key required).
  app.post("/v1/agents/:id/archive", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    requireIdempotencyKey(req);
    const { id } = req.params as { id: string };
    const agent = await archiveAgent(opts.pool, ctx, id);
    return reply.status(200).send(agent);
  });

  // GET /v1/agents/:id/versions — list versions.
  app.get("/v1/agents/:id/versions", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    const { limit, cursor } = parseListParams(req);
    const result = await listVersions(opts.pool, ctx, id, { limit, cursor });
    return reply.status(200).send(paginate(result.data, result.nextCursor ?? undefined));
  });

  // GET /v1/agents/:id/versions/:ver — retrieve a version.
  app.get(
    "/v1/agents/:id/versions/:ver",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(req);
      const { id, ver } = req.params as { id: string; ver: string };
      const version = Number(ver);
      if (!Number.isInteger(version) || version < 1) {
        throw new ApiError(404, "not_found", `agent version not found: ${id} v${ver}`);
      }
      const v = await getVersion(opts.pool, ctx, id, version);
      return reply.status(200).send(v);
    },
  );
};
