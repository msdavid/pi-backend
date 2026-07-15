/**
 * Sessions API routes (WP-1.6, §"Sessions").
 *
 * - `POST /v1/sessions`               — create (`Idempotency-Key` required).
 * - `GET /v1/sessions`                — list (paginated; `status`/`agentId`/`environmentId` filters).
 * - `GET /v1/sessions/:id`            — retrieve (status, usage, config).
 * - `PATCH /v1/sessions/:id`         — update `agent.tools`/`agent.mcpServers` (idle only).
 * - `DELETE /v1/sessions/:id`        — soft-delete (archives JSONL; resources untouched) → `204`.
 * - `POST /v1/sessions/:id/fork`     — fork (`Idempotency-Key` required).
 * - `GET /v1/sessions/:id/entries`  — positional log slice.
 * - `GET /v1/sessions/:id/tree`     — JSONL tree structure.
 * - `GET /v1/sessions/:id/messages` — post-compaction LLM-context messages.
 * - `GET /v1/sessions/:id/usage`    — cumulative token usage.
 * - `GET /v1/sessions/:id/metrics`  — live sandbox resource sample (§26.4; needs a provider).
 *
 * Validation is delegated to the `@pi-managed/contracts` zod schemas; the create
 * `agent` field's three forms (bare id / pinned / overrides) are handled in the
 * domain create layer. Every route relies on the auth middleware having set
 * `request.tenantCtx`. Idempotency replay protection is applied globally by the
 * P0.5 middleware; mutating POSTs only need to require the header here.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { requireScopeByMethod } from "./middleware/scope.js";
import { type Pool } from "../infra/db/index.js";
import { ApiError } from "../domain/errors.js";
import { parseListParams, paginate } from "./middleware/pagination.js";
import { SessionPatch } from "@pi-managed/contracts";
import type { ObjectStore, SandboxHandle, SandboxProvider } from "../domain/ports.js";
import {
  createSession,
  forkSession,
  getSession,
  listSessions,
  updateSession,
  deleteSession,
  fetchSessionRow,
  getSessionEntries,
  getSessionTree,
  getSessionMessages,
  getSessionUsage,
} from "../domain/session/index.js";

export interface SessionRoutesOptions {
  pool: Pool;
  /** Optional object store for JSONL reads (entries/tree/messages). */
  objectStore?: ObjectStore;
  /**
   * Optional sandbox provider. Supplied → `GET /v1/sessions/:id/metrics` is mounted and
   * samples the session's live VM (§26.4). Absent (no sandboxing configured) → the route
   * is not registered at all, so it 404s like any unknown path rather than pretending to
   * exist and always answering "no metrics".
   */
  sandboxProvider?: SandboxProvider;
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

/** Parse an optional integer query param. */
function optionalInt(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

export const sessionRoutes: FastifyPluginAsync<SessionRoutesOptions> = async (
  app,
  opts,
) => {
  // R0.1: enforce API-key scopes on every route in this plugin (GET/HEAD → read,
  // mutating → write; `admin` passes all; worker keys are denied here).
  app.addHook("preHandler", requireScopeByMethod);
  // POST /v1/sessions — create (Idempotency-Key required; lazy sandbox, no work).
  app.post("/v1/sessions", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    requireIdempotencyKey(req);
    const created = await createSession(opts.pool, ctx, req.body);
    return reply.status(201).send(created);
  });

  // GET /v1/sessions — list (paginated; status/agentId/environmentId filters).
  app.get("/v1/sessions", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    const { limit, cursor } = parseListParams(req);
    const q = (req.query ?? {}) as {
      status?: string;
      agentId?: string;
      environmentId?: string;
    };
    const result = await listSessions(opts.pool, ctx, {
      limit,
      cursor,
      status: q.status as never,
      agentId: q.agentId,
      environmentId: q.environmentId,
    });
    return reply.status(200).send(paginate(result.data, result.nextCursor ?? undefined));
  });

  // GET /v1/sessions/:id — retrieve.
  app.get("/v1/sessions/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    const session = await getSession(opts.pool, ctx, id);
    if (!session) {
      throw new ApiError(404, "not_found", `session not found: ${id}`);
    }
    return reply.status(200).send(session);
  });

  // PATCH /v1/sessions/:id — update agent.tools/agent.mcpServers (idle only).
  app.patch("/v1/sessions/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    const parsed = SessionPatch.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(
        422,
        "invalid_request",
        `invalid session patch: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      );
    }
    const agentPatch = parsed.data.agent;
    const updated = await updateSession(opts.pool, ctx, id, {
      tools: agentPatch.tools,
      mcpServers: agentPatch.mcpServers,
    });
    if (!updated) {
      throw new ApiError(404, "not_found", `session not found: ${id}`);
    }
    return reply.status(200).send(updated);
  });

  // DELETE /v1/sessions/:id — soft-delete (archives JSONL; resources untouched) → 204.
  app.delete("/v1/sessions/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    const deleted = await deleteSession(opts.pool, ctx, id);
    if (!deleted) {
      throw new ApiError(404, "not_found", `session not found: ${id}`);
    }
    return reply.status(204).send();
  });

  // POST /v1/sessions/:id/fork — fork (Idempotency-Key required).
  app.post("/v1/sessions/:id/fork", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    requireIdempotencyKey(req);
    const { id } = req.params as { id: string };
    const forked = await forkSession(opts.pool, ctx, id);
    return reply.status(201).send(forked);
  });

  // GET /v1/sessions/:id/entries — positional log slice.
  app.get(
    "/v1/sessions/:id/entries",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(req);
      const { id } = req.params as { id: string };
      const row = await fetchSessionRow(opts.pool, ctx, id);
      if (!row || row.status === "archived") {
        throw new ApiError(404, "not_found", `session not found: ${id}`);
      }
      const q = (req.query ?? {}) as { from?: string; to?: string; limit?: string };
      const { limit } = parseListParams(req);
      const result = await getSessionEntries(opts.objectStore, row.jsonl_object_key, {
        from: optionalInt(q.from),
        to: optionalInt(q.to),
        limit,
      });
      return reply.status(200).send(paginate(result.data, result.nextCursor ?? undefined));
    },
  );

  // GET /v1/sessions/:id/tree — JSONL tree structure.
  app.get("/v1/sessions/:id/tree", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    const row = await fetchSessionRow(opts.pool, ctx, id);
    if (!row || row.status === "archived") {
      throw new ApiError(404, "not_found", `session not found: ${id}`);
    }
    const tree = await getSessionTree(opts.objectStore, row.jsonl_object_key);
    return reply.status(200).send(tree);
  });

  // GET /v1/sessions/:id/messages — post-compaction LLM-context messages.
  app.get(
    "/v1/sessions/:id/messages",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(req);
      const { id } = req.params as { id: string };
      const row = await fetchSessionRow(opts.pool, ctx, id);
      if (!row || row.status === "archived") {
        throw new ApiError(404, "not_found", `session not found: ${id}`);
      }
      const messages = await getSessionMessages(opts.objectStore, row.jsonl_object_key);
      return reply.status(200).send({ data: messages });
    },
  );

  // GET /v1/sessions/:id/usage — cumulative token usage.
  app.get(
    "/v1/sessions/:id/usage",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(req);
      const { id } = req.params as { id: string };
      const usage = await getSessionUsage(opts.pool, ctx, id);
      if (!usage) {
        throw new ApiError(404, "not_found", `session not found: ${id}`);
      }
      return reply.status(200).send(usage);
    },
  );

  // GET /v1/sessions/:id/metrics — live sandbox resource sample (§26.4).
  //
  // Mounted only when a sandbox provider is wired. Reads are `read`-scoped by the
  // plugin-wide `requireScopeByMethod` hook, and the session row is fetched
  // tenant-scoped (`fetchSessionRow` runs under RLS), so one tenant can never sample
  // another's VM. This is a PULL: the provider asks the running VM for its counters —
  // it does not wake, provision, or start anything, so polling it is safe.
  if (opts.sandboxProvider) {
    const provider = opts.sandboxProvider;
    app.get(
      "/v1/sessions/:id/metrics",
      async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = requireCtx(req);
        const { id } = req.params as { id: string };
        const row = await fetchSessionRow(opts.pool, ctx, id);
        if (!row || row.status === "archived") {
          throw new ApiError(404, "not_found", `session not found: ${id}`);
        }
        const metrics = row.sandbox_handle
          ? await provider.metrics?.(handleFromRow(row.sandbox_handle, ctx.tenantId, id))
          : null;
        // No VM was ever provisioned (lazy sandbox), it is checkpointed/crashed/gone, or
        // this provider reports no metrics (e.g. self-hosted §10.4): all of it is "there
        // is nothing to sample", which is a 404 — never a fabricated zero sample.
        if (!metrics) {
          throw new ApiError(
            404,
            "not_found",
            `no live sandbox metrics for session: ${id}`,
          );
        }
        return reply.status(200).send({ sessionId: id, ...metrics });
      },
    );
  }
};

/**
 * Rebuild the provider handle from the session row's persisted `sandbox_handle` (the
 * tenant-namespaced VM name — the provider's stable primary key; `id === name`, see
 * `db-session-store.ts`). Lets the metrics read address the VM without waking the
 * session's runtime.
 */
function handleFromRow(
  sandboxHandle: string,
  tenantId: string,
  sessionId: string,
): SandboxHandle {
  return {
    id: sandboxHandle,
    name: sandboxHandle,
    labels: { tenant: tenantId, session: sessionId },
  };
}
