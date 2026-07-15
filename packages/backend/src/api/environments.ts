/**
 * Environment routes (WP-1.2, §"Environments").
 *
 * - `POST /v1/environments` — create (`Idempotency-Key` required); `cloud` only.
 * - `GET /v1/environments` — list (cursor-paginated, optional `status` filter).
 * - `GET /v1/environments/:id` — retrieve.
 * - `PATCH /v1/environments/:id` — update (not versioned).
 * - `DELETE /v1/environments/:id` — hard delete → `204`.
 * - `POST /v1/environments/:id/archive` — archive → `200` with `status: archived`.
 * - `GET /v1/environments/:id/work-stats` — self-hosted queue depth (§10.4).
 * - `POST /v1/environments/:id/work-stop` — request the worker to stop (§10.4).
 *
 * `self_hosted` is supported (WP-4.1, §10.4); the unsupported-features matrix
 * is enforced at session creation (domain/self-hosted/constraints.ts).
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { type Pool } from "../infra/db/index.js";
import { requireScopeByMethod } from "./middleware/scope.js";
import { ApiError } from "../domain/errors.js";
import {
  decodeCursor,
  encodeCursor,
  parseListParams,
  paginate,
} from "./middleware/pagination.js";
import { EnvironmentCreate, EnvironmentUpdate, WorkStopRequest } from "@pi-managed/contracts";
import {
  createEnvironment,
  listEnvironments,
  getEnvironment,
  updateEnvironment,
  deleteEnvironment,
  archiveEnvironment,
  type EnvCursor,
} from "../domain/environment/environment.js";
import { getWorkStats } from "../domain/self-hosted/work-stats.js";
import { stopWork } from "../domain/self-hosted/work-stop.js";
import { assertOrgKey } from "../domain/self-hosted/worker-keys.js";

export interface EnvironmentRoutesOptions {
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

/** Require and validate the `Idempotency-Key` header (mutating POSTs). */
function requireIdempotencyKey(req: FastifyRequest): string {
  const key = req.headers["idempotency-key"];
  if (!key || Array.isArray(key) || typeof key !== "string" || key.trim() === "") {
    throw new ApiError(
      400,
      "invalid_request",
      "Idempotency-Key header is required",
    );
  }
  return key;
}

export const environmentRoutes: FastifyPluginAsync<EnvironmentRoutesOptions> =
  async (app, opts) => {
    // R0.1: enforce API-key scopes on every route in this plugin (GET/HEAD →
    // read, mutating → write; `admin` passes all). The self-hosted `work-stop`
    // route (R0.2) is exempt — it keeps its own org-key auth (assertOrgKey) and
    // must NOT gain a scope guard, so a `read` org key can still stop work.
    app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
      if (req.routeOptions.url === "/v1/environments/:id/work-stop") return;
      return requireScopeByMethod(req, reply);
    });
    // POST /v1/environments — create (Idempotency-Key required; cloud only).
    app.post(
      "/v1/environments",
      async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = requireCtx(req);
        requireIdempotencyKey(req);
        const parsed = EnvironmentCreate.safeParse(req.body);
        if (!parsed.success) {
          throw new ApiError(
            422,
            "invalid_request",
            `invalid request body: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          );
        }
        const env = await createEnvironment(opts.pool, ctx, parsed.data);
        return reply.status(201).send(env);
      },
    );

    // GET /v1/environments — list (paginated; optional status filter).
    app.get(
      "/v1/environments",
      async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = requireCtx(req);
        const { limit, cursor } = parseListParams(req);
        const query = (req.query ?? {}) as { status?: string };
        const status =
          query.status === "active" || query.status === "archived"
            ? query.status
            : undefined;
        let decoded: EnvCursor | undefined;
        if (cursor) {
          try {
            decoded = decodeCursor<EnvCursor>(cursor);
          } catch {
            throw new ApiError(400, "invalid_request", "invalid cursor");
          }
        }
        const page = await listEnvironments(opts.pool, ctx, {
          limit,
          cursor: decoded,
          status,
        });
        const nextCursor = page.nextCursor
          ? encodeCursor({
              createdAt: page.nextCursor.createdAt,
              id: page.nextCursor.id,
            })
          : undefined;
        return reply.status(200).send(paginate(page.data, nextCursor));
      },
    );

    // GET /v1/environments/:id — retrieve.
    app.get(
      "/v1/environments/:id",
      async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = requireCtx(req);
        const { id } = req.params as { id: string };
        const env = await getEnvironment(opts.pool, ctx, id);
        if (!env) {
          throw new ApiError(404, "not_found", `environment not found: ${id}`);
        }
        return reply.status(200).send(env);
      },
    );

    // PATCH /v1/environments/:id — update (not versioned).
    app.patch(
      "/v1/environments/:id",
      async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = requireCtx(req);
        const { id } = req.params as { id: string };
        const parsed = EnvironmentUpdate.safeParse(req.body);
        if (!parsed.success) {
          throw new ApiError(
            422,
            "invalid_request",
            `invalid request body: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          );
        }
        const env = await updateEnvironment(opts.pool, ctx, id, parsed.data);
        if (!env) {
          throw new ApiError(404, "not_found", `environment not found: ${id}`);
        }
        return reply.status(200).send(env);
      },
    );

    // DELETE /v1/environments/:id — hard delete (204).
    app.delete(
      "/v1/environments/:id",
      async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = requireCtx(req);
        const { id } = req.params as { id: string };
        const ok = await deleteEnvironment(opts.pool, ctx, id);
        if (!ok) {
          throw new ApiError(404, "not_found", `environment not found: ${id}`);
        }
        return reply.status(204).send();
      },
    );

    // POST /v1/environments/:id/archive — archive (Idempotency-Key required).
    app.post(
      "/v1/environments/:id/archive",
      async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = requireCtx(req);
        requireIdempotencyKey(req);
        const { id } = req.params as { id: string };
        const env = await archiveEnvironment(opts.pool, ctx, id);
        if (!env) {
          throw new ApiError(404, "not_found", `environment not found: ${id}`);
        }
        return reply.status(200).send(env);
      },
    );

    // GET /v1/environments/:id/work-stats — self-hosted queue depth (§10.4).
    app.get(
      "/v1/environments/:id/work-stats",
      async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = requireCtx(req);
        const { id } = req.params as { id: string };
        const stats = await getWorkStats(opts.pool, ctx, id);
        return reply.status(200).send(stats);
      },
    );

    // POST /v1/environments/:id/work-stop — request the worker handling a
    // self-hosted session to stop (§10.4). Org-key auth (NOT the environment key).
    // NOTE: the work-stop target is a session, not an environment; the route is
    // mounted under /environments/:id per §10.4 and the body carries sessionId.
    app.post(
      "/v1/environments/:id/work-stop",
      async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = requireCtx(req);
        requireIdempotencyKey(req);
        const bearer =
          typeof req.headers.authorization === "string"
            ? req.headers.authorization.slice("Bearer ".length).trim()
            : "";
        // Org-key auth: reject environment worker keys (§10.4).
        await assertOrgKey(opts.pool, ctx, bearer || "invalid");
        const parsed = WorkStopRequest.safeParse(req.body ?? {});
        if (!parsed.success) {
          throw new ApiError(
            422,
            "invalid_request",
            `invalid request body: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          );
        }
        const body = req.body as { sessionId?: string } | undefined;
        const sessionId = body?.sessionId;
        if (!sessionId) {
          throw new ApiError(
            422,
            "invalid_request",
            "sessionId is required in the request body",
          );
        }
        const item = await stopWork(opts.pool, ctx, sessionId, parsed.data);
        if (!item) {
          throw new ApiError(
            404,
            "not_found",
            `work item not found for session: ${sessionId}`,
          );
        }
        return reply.status(200).send(item);
      },
    );
  };
