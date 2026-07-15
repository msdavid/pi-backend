/**
 * Session Outcomes API routes (WP-3.2, §"Outcomes").
 *
 * - `POST /v1/sessions/:id/outcomes` — define an outcome (`Idempotency-Key` required;
 *   equivalent to `user.define_outcome`, §16.3). One at a time per session (`409` if
 *   one is active, §16.5). Returns `202` with the new outcome.
 * - `GET  /v1/sessions/:id/outcomes` — list outcome evaluations + results (cursor-
 *   paginated, §16.5).
 * - `POST /v1/sessions/:id/outcomes/:outcomeId/cancel` — cancel a running outcome (R6.3):
 *   aborts the in-process loop and persists the terminal `interrupted` status, releasing
 *   the session's one-at-a-time slot. Idempotent (`200` with the outcome).
 *
 * `result` taxonomy (§16.5): `satisfied` | `needs_revision` | `max_iterations_reached`
 * | `failed` | `interrupted`. Deliverables are fetched through the Files API scoped to
 * the session once idle (`GET /v1/files?sessionId=`, §16.6).
 *
 * Defining an outcome provisions a grader + runs the iteration loop. The loop is driven
 * by an injected `OutcomeRunner` (the composition root wires the session runtime +
 * grader); when no runner is supplied (tests), the route only persists the outcome
 * (`status: "active"`) and returns `202`.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { requireScopeByMethod } from "./middleware/scope.js";
import { type Pool, type TenantCtx } from "../infra/db/index.js";
import { ApiError } from "../domain/errors.js";
import { parseListParams, paginate } from "./middleware/pagination.js";
import {
  cancelOutcome,
  cancelOutcomeRun,
  defineOutcome,
  listOutcomes,
} from "../domain/outcome/index.js";

export interface OutcomeRoutesOptions {
  pool: Pool;
  /**
   * Optional hook that runs the iteration loop for a freshly-defined outcome. Wired
   * by the composition root when a session runtime + grader are available; fired
   * without awaiting (the loop is long-lived and stream-driven). Omitted in tests.
   */
  runOutcomeLoop?: (
    tenantCtx: TenantCtx,
    sessionId: string,
    outcomeId: string,
  ) => Promise<void>;
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

export const sessionOutcomeRoutes: FastifyPluginAsync<OutcomeRoutesOptions> = async (
  app,
  opts,
) => {
  // R0.1: enforce API-key scopes on every route in this plugin (GET/HEAD → read,
  // mutating → write; `admin` passes all; worker keys are denied here).
  app.addHook("preHandler", requireScopeByMethod);
  // POST /v1/sessions/:id/outcomes — define an outcome (Idempotency-Key required; 202).
  app.post("/v1/sessions/:id/outcomes", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    requireIdempotencyKey(req);
    const { id: sessionId } = req.params as { id: string };
    const outcome = await defineOutcome(opts.pool, ctx, sessionId, req.body);
    // Kick off the iteration loop (fire-and-forget). The runner owns driving the
    // session runtime + grader; errors are surfaced via the session stream, not here.
    if (opts.runOutcomeLoop) {
      void opts.runOutcomeLoop(ctx, sessionId, outcome.id).catch(() => {
        // Swallowed: the loop records `failed`/`interrupted` in the outcome row +
        // emits the terminal event on its own stream. A throw here is a wiring fault.
      });
    }
    return reply.status(202).send(outcome);
  });

  // POST /v1/sessions/:id/outcomes/:outcomeId/cancel — cancel a running outcome (R6.3).
  // Aborts the in-process loop (an in-flight grade included) and persists `interrupted`
  // so the session's one-at-a-time slot (§16.5) is released. Idempotent: cancelling an
  // already-terminal outcome returns it unchanged (200).
  app.post(
    "/v1/sessions/:id/outcomes/:outcomeId/cancel",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(req);
      const { id: sessionId, outcomeId } = req.params as {
        id: string;
        outcomeId: string;
      };
      cancelOutcomeRun(outcomeId);
      const outcome = await cancelOutcome(opts.pool, ctx, sessionId, outcomeId);
      return reply.status(200).send(outcome);
    },
  );

  // GET /v1/sessions/:id/outcomes — list evaluations + results (cursor-paginated).
  app.get("/v1/sessions/:id/outcomes", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    const { id: sessionId } = req.params as { id: string };
    const { limit, cursor } = parseListParams(req);
    const result = await listOutcomes(opts.pool, ctx, sessionId, { limit, cursor });
    return reply
      .status(200)
      .send(paginate(result.data, result.nextCursor ?? undefined));
  });
};
