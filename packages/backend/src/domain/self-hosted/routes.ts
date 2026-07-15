/**
 * Self-hosted work-queue routes (WP-4.1, §10.4).
 *
 * Mounted by `server.ts`. The `work-stats` (`GET /v1/environments/:id/work-stats`)
 * and `work-stop` (`POST /v1/environments/:id/work-stop`) endpoints live in
 * `api/environments.ts` (per WP-4.1 owned paths); this plugin owns the worker
 * surface:
 *
 *  - `POST /v1/environments/:id/worker-keys` — issue a worker key scoped to the
 *    environment (org-key auth; the raw key is shown once).
 *  - `POST /v1/environments/:id/work-claim` — a worker polls/claims the next
 *    queued item (worker-key auth scoped to `:id`).
 *  - `POST /v1/sessions/:id/work-result` — a worker posts a `user.tool_result`
 *    event (§9.2) (worker-key auth scoped to the session's environment).
 *
 * All routes rely on the global bearer-auth middleware having set
 * `request.tenantCtx` (worker keys are tenant-scoped API keys, §27.1).
 */

import { z } from "zod";
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { type Pool } from "../../infra/db/index.js";
import { ApiError } from "../errors.js";
import {
  issueWorkerKey,
  requireWorkerKeyForEnv,
  assertOrgKey,
} from "./worker-keys.js";
import {
  claim,
  postResult,
  fetchWorkItem,
  getToolResultSink,
} from "./work-queue.js";
import { requireScope } from "../../api/middleware/scope.js";

export interface SelfHostedRoutesOptions {
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

/** Read the raw bearer token from the `Authorization` header (or throw 401). */
function requireBearer(req: FastifyRequest): string {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    throw new ApiError(401, "unauthorized", "missing or invalid Authorization header");
  }
  const raw = header.slice("Bearer ".length).trim();
  if (!raw) {
    throw new ApiError(401, "unauthorized", "missing API key");
  }
  return raw;
}

/** Require and validate the `Idempotency-Key` header (mutating POSTs). */
function requireIdempotencyKey(req: FastifyRequest): string {
  const key = req.headers["idempotency-key"];
  if (
    !key ||
    Array.isArray(key) ||
    typeof key !== "string" ||
    key.trim() === ""
  ) {
    throw new ApiError(400, "invalid_request", "Idempotency-Key header is required");
  }
  return key;
}

const IssueWorkerKeyBody = z.object({ name: z.string().min(1).max(128) });

/**
 * A worker-posted `user.tool_result` (§9.2). `toolUseId` correlates it with the
 * `work_spec.toolCalls` entry the {@link SelfHostedToolChannel} enqueued; it is required
 * for the result to reach the live session (R6.6) — without it the model's tool call
 * could never be resolved. Extra fields are preserved on the persisted event.
 */
const WorkResultBody = z.object({
  type: z.literal("user.tool_result"),
  toolUseId: z.string().min(1),
  result: z.string().default(""),
  isError: z.boolean().optional(),
}).passthrough();

export const selfHostedRoutes: FastifyPluginAsync<SelfHostedRoutesOptions> =
  async (app, opts) => {
    // POST /v1/environments/:id/worker-keys — issue a worker key (org-key auth).
    // R0.1/R0.2: worker-key *issuance* is an ordinary mutating admin action, so
    // it carries a `write` scope guard (an `admin` org key passes). The two
    // work-queue routes below (claim + work-result) intentionally carry NO scope
    // guard: they are the only surface a `self_hosted_worker:<envId>` key may
    // reach, and enforce their environment binding via requireWorkerKeyForEnv.
    app.post(
      "/v1/environments/:id/worker-keys",
      { preHandler: requireScope("write") },
      async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = requireCtx(req);
        requireIdempotencyKey(req);
        const { id: envId } = req.params as { id: string };
        const bearer = requireBearer(req);
        // Org-key auth: reject worker keys (§10.4).
        await assertOrgKey(opts.pool, ctx, bearer);
        const parsed = IssueWorkerKeyBody.safeParse(req.body);
        if (!parsed.success) {
          throw new ApiError(
            422,
            "invalid_request",
            `invalid request body: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          );
        }
        const issued = await issueWorkerKey(opts.pool, ctx, envId, parsed.data.name);
        return reply.status(201).send(issued);
      },
    );

    // POST /v1/environments/:id/work-claim — a worker polls/claims the next item.
    app.post(
      "/v1/environments/:id/work-claim",
      async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = requireCtx(req);
        const { id: envId } = req.params as { id: string };
        const bearer = requireBearer(req);
        // Worker-key auth scoped to THIS environment (§10.4).
        const worker = await requireWorkerKeyForEnv(opts.pool, ctx, bearer, envId);
        const item = await claim(opts.pool, ctx, envId, worker.apiKeyId);
        if (!item) {
          // No queued work — 204 (the worker polls again).
          return reply.status(204).send();
        }
        return reply.status(200).send(item);
      },
    );

    // POST /v1/sessions/:id/work-result — a worker posts a user.tool_result (§9.2).
    app.post(
      "/v1/sessions/:id/work-result",
      async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = requireCtx(req);
        const { id: sessionId } = req.params as { id: string };
        const bearer = requireBearer(req);
        // Resolve the work item to learn its environment, then enforce the worker
        // key is scoped to that environment.
        const item = await fetchWorkItem(opts.pool, ctx, sessionId);
        if (!item) {
          throw new ApiError(
            404,
            "not_found",
            `work item not found for session: ${sessionId}`,
          );
        }
        await requireWorkerKeyForEnv(opts.pool, ctx, bearer, item.environmentId);
        const parsed = WorkResultBody.safeParse(req.body);
        if (!parsed.success) {
          throw new ApiError(
            422,
            "invalid_request",
            `invalid request body: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          );
        }
        const updated = await postResult(opts.pool, ctx, sessionId, parsed.data);
        // R6.6: close the round trip. Persisting the result on the work item is the
        // durable channel; the model's tool call only resolves when the result reaches
        // the LIVE runtime as a `user.tool_result` (§9.2). The sink is registered by the
        // composition root and resolves the runtime through the SessionManager. A
        // delivery failure (no live runtime on this node — the session was evicted) is
        // NOT fatal: the result stays persisted on the item.
        try {
          await getToolResultSink()?.deliver(sessionId, {
            toolUseId: parsed.data.toolUseId,
            result: parsed.data.result,
            isError: parsed.data.isError ?? false,
          });
        } catch (err) {
          req.log.warn(
            { sessionId, err: (err as Error).message },
            "self-hosted work-result: live-runtime delivery failed",
          );
        }
        return reply.status(200).send(updated);
      },
    );
  };
