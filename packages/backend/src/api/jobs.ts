/**
 * Scheduled Jobs API routes (WP-2.1, §"Scheduled Jobs (Crons)").
 *
 * - `POST /v1/jobs`               — create (`Idempotency-Key` required).
 * - `GET /v1/jobs`                — list (cursor-paginated; `?status=` filter).
 * - `GET /v1/jobs/:id`            — retrieve.
 * - `POST /v1/jobs/:id/pause`     — pause (`Idempotency-Key` required).
 * - `POST /v1/jobs/:id/unpause`   — resume (`Idempotency-Key` required).
 * - `POST /v1/jobs/:id/archive`   — archive (terminal; `Idempotency-Key` required).
 * - `POST /v1/jobs/:id/run`       — manual trigger (works while paused; `Idempotency-Key` required).
 * - `GET /v1/jobs/:id/runs`       — list runs (cursor-paginated).
 *
 * Validation is delegated to the `@pi-managed/contracts` zod schemas (re-used
 * inside the job service). Every route relies on the auth middleware having set
 * `request.tenantCtx`; idempotency replay protection is applied globally by the
 * P0.5 middleware. Mutating POSTs only need to require the header here.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { requireScopeByMethod } from "./middleware/scope.js";
import { type Pool } from "../infra/db/index.js";
import { ApiError } from "../domain/errors.js";
import { parseListParams, paginate } from "./middleware/pagination.js";
import {
  createJob,
  listJobs,
  getJob,
  pauseJob,
  unpauseJob,
  archiveJob,
  runJob,
  listRuns,
} from "../domain/scheduler/index.js";
import type { TriggerSessionFn } from "../domain/scheduler/index.js";
import type { TenantCtx } from "../infra/db/index.js";

export interface JobRoutesOptions {
  pool: Pool;
  /**
   * Optional hook to dispatch a job's `initialEvents` into the created session
   * (manual run path). Wired by the composition root when a SessionManager is
   * available; omitted in tests.
   */
  triggerSession?: TriggerSessionFn;
}

/** Resolve the authenticated tenant context or throw 401. */
function requireCtx(req: FastifyRequest): TenantCtx {
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

export const jobRoutes: FastifyPluginAsync<JobRoutesOptions> = async (app, opts) => {
  // R0.1: enforce API-key scopes on every route in this plugin (GET/HEAD → read,
  // mutating → write; `admin` passes all; worker keys are denied here).
  app.addHook("preHandler", requireScopeByMethod);
  // POST /v1/jobs — create (Idempotency-Key required).
  app.post("/v1/jobs", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    requireIdempotencyKey(req);
    const created = await createJob(opts.pool, ctx, req.body);
    return reply.status(201).send(created);
  });

  // GET /v1/jobs — list (cursor-paginated; ?status= filter).
  app.get("/v1/jobs", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    const { limit, cursor } = parseListParams(req);
    const q = (req.query ?? {}) as { status?: string };
    const result = await listJobs(opts.pool, ctx, {
      limit,
      cursor,
      status: q.status as never,
    });
    return reply.status(200).send(paginate(result.data, result.nextCursor ?? undefined));
  });

  // GET /v1/jobs/:id — retrieve.
  app.get("/v1/jobs/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    const job = await getJob(opts.pool, ctx, id);
    if (!job) {
      throw new ApiError(404, "not_found", `job not found: ${id}`);
    }
    return reply.status(200).send(job);
  });

  // POST /v1/jobs/:id/pause — pause (Idempotency-Key required).
  app.post("/v1/jobs/:id/pause", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    requireIdempotencyKey(req);
    const { id } = req.params as { id: string };
    const job = await pauseJob(opts.pool, ctx, id);
    return reply.status(200).send(job);
  });

  // POST /v1/jobs/:id/unpause — resume (Idempotency-Key required).
  app.post("/v1/jobs/:id/unpause", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    requireIdempotencyKey(req);
    const { id } = req.params as { id: string };
    const job = await unpauseJob(opts.pool, ctx, id);
    return reply.status(200).send(job);
  });

  // POST /v1/jobs/:id/archive — archive (terminal; Idempotency-Key required).
  app.post("/v1/jobs/:id/archive", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    requireIdempotencyKey(req);
    const { id } = req.params as { id: string };
    const job = await archiveJob(opts.pool, ctx, id);
    return reply.status(200).send(job);
  });

  // POST /v1/jobs/:id/run — manual trigger (works while paused; 202).
  app.post("/v1/jobs/:id/run", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    requireIdempotencyKey(req);
    const { id } = req.params as { id: string };
    const result = await runJob(opts.pool, ctx, id, opts.triggerSession);
    return reply.status(202).send(result);
  });

  // GET /v1/jobs/:id/runs — list runs (cursor-paginated).
  app.get("/v1/jobs/:id/runs", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    const { limit, cursor } = parseListParams(req);
    const result = await listRuns(opts.pool, ctx, id, { limit, cursor });
    return reply.status(200).send(paginate(result.data, result.nextCursor ?? undefined));
  });
};
