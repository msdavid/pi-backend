/**
 * Memory store + memory + version routes (WP-2.2, api-reference.md §"Memory stores").
 *
 * - `POST   /v1/memory-stores`                       — create store (`Idempotency-Key`).
 * - `GET    /v1/memory-stores`                       — list (paginated).
 * - `GET    /v1/memory-stores/:id`                   — retrieve.
 * - `PATCH  /v1/memory-stores/:id`                  — update title/instructions/access.
 * - `DELETE /v1/memory-stores/:id`                  — hard delete → `204`.
 * - `GET    /v1/memory-stores/:id/memories`         — list memories (no content).
 * - `POST   /v1/memory-stores/:id/memories`        — create memory (`Idempotency-Key`).
 * - `GET    /v1/memory-stores/:id/memories/:m`      — retrieve memory (with content).
 * - `PATCH  /v1/memory-stores/:id/memories/:m`      — update (sha256 optimistic concurrency).
 * - `DELETE /v1/memory-stores/:id/memories/:m`      — delete memory → `204`.
 * - `GET    /v1/memory-stores/:id/versions`         — list versions (audit trail).
 * - `GET    /v1/memory-stores/:id/versions/:v`      — retrieve a version.
 * - `POST   /v1/memory-stores/:id/versions/:v/redact` — redact (`Idempotency-Key`).
 *
 * `:m` (memory) and `:v` (version) are path params; `:m` is the memory's
 * `path`, percent-encoded by the client when it contains `/`.
 *
 * Validation is delegated to the `@pi-managed/contracts` zod schemas. Every
 * route relies on the auth middleware having set `request.tenantCtx`.
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { requireScopeByMethod } from "./middleware/scope.js";
import { type Pool } from "../infra/db/index.js";
import { ApiError } from "../domain/errors.js";
import { parseListParams, paginate } from "./middleware/pagination.js";
import type { ObjectStore } from "../domain/ports.js";
import {
  MemoryStoreCreate,
  MemoryStoreUpdate,
  MemoryCreate,
  MemoryUpdate,
  MemoryVersionRedactRequest,
} from "@pi-managed/contracts";
import {
  createMemoryStore,
  listMemoryStores,
  getMemoryStore,
  updateMemoryStore,
  deleteMemoryStore,
  createMemory,
  getMemory,
  updateMemory,
  deleteMemory,
  listMemories,
  listMemoryVersions,
  getMemoryVersion,
  redactVersion,
} from "../domain/memory/index.js";

export interface MemoryRoutesOptions {
  pool: Pool;
  /** Object store for memory content (required — content lives here, not Postgres). */
  objectStore: ObjectStore;
}

/** Resolve the authenticated tenant context or throw 401. */
function requireCtx(req: FastifyRequest) {
  const ctx = req.tenantCtx;
  if (!ctx) {
    throw new ApiError(401, "unauthorized", "missing tenant context");
  }
  return ctx;
}

/** Require a non-empty `Idempotency-Key` header (mutating POST endpoints). */
function requireIdempotencyKey(req: FastifyRequest): void {
  const key = req.headers["idempotency-key"];
  if (!key || Array.isArray(key) || String(key).trim() === "") {
    throw new ApiError(400, "invalid_request", "Idempotency-Key header is required");
  }
}

/** Format a zod issue list as a single message. */
function zodMessage(issues: { message: string }[]): string {
  return `invalid request body: ${issues.map((i) => i.message).join("; ")}`;
}

export const memoryRoutes: FastifyPluginAsync<MemoryRoutesOptions> = async (
  app,
  opts,
) => {
  // R0.1: enforce API-key scopes on every route in this plugin (GET/HEAD → read,
  // mutating → write; `admin` passes all; worker keys are denied here).
  app.addHook("preHandler", requireScopeByMethod);
  const pool = opts.pool;
  const objectStore = opts.objectStore;

  // POST /v1/memory-stores — create store.
  app.post(
    "/v1/memory-stores",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(req);
      requireIdempotencyKey(req);
      const parsed = MemoryStoreCreate.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(422, "invalid_request", zodMessage(parsed.error.issues));
      }
      const store = await createMemoryStore(pool, ctx, parsed.data);
      return reply.status(201).send(store);
    },
  );

  // GET /v1/memory-stores — list.
  app.get(
    "/v1/memory-stores",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(req);
      const { limit, cursor } = parseListParams(req);
      const result = await listMemoryStores(pool, ctx, { limit, cursor });
      return reply
        .status(200)
        .send(paginate(result.data, result.nextCursor ?? undefined));
    },
  );

  // GET /v1/memory-stores/:id — retrieve.
  app.get(
    "/v1/memory-stores/:id",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(req);
      const { id } = req.params as { id: string };
      const store = await getMemoryStore(pool, ctx, id);
      if (!store) {
        throw new ApiError(404, "not_found", `memory store not found: ${id}`);
      }
      return reply.status(200).send(store);
    },
  );

  // PATCH /v1/memory-stores/:id — update title/instructions/access.
  app.patch(
    "/v1/memory-stores/:id",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(req);
      const { id } = req.params as { id: string };
      const parsed = MemoryStoreUpdate.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(422, "invalid_request", zodMessage(parsed.error.issues));
      }
      const store = await updateMemoryStore(pool, ctx, id, parsed.data);
      return reply.status(200).send(store);
    },
  );

  // DELETE /v1/memory-stores/:id — hard delete.
  app.delete(
    "/v1/memory-stores/:id",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(req);
      const { id } = req.params as { id: string };
      await deleteMemoryStore(pool, ctx, id);
      return reply.status(204).send();
    },
  );

  // GET /v1/memory-stores/:id/memories — list memories (no content).
  app.get(
    "/v1/memory-stores/:id/memories",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(req);
      const { id } = req.params as { id: string };
      const { limit, cursor } = parseListParams(req);
      const result = await listMemories(pool, ctx, id, { limit, cursor });
      return reply
        .status(200)
        .send(paginate(result.data, result.nextCursor ?? undefined));
    },
  );

  // POST /v1/memory-stores/:id/memories — create memory.
  app.post(
    "/v1/memory-stores/:id/memories",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(req);
      requireIdempotencyKey(req);
      const { id } = req.params as { id: string };
      const parsed = MemoryCreate.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(422, "invalid_request", zodMessage(parsed.error.issues));
      }
      const mem = await createMemory(pool, ctx, objectStore, id, parsed.data);
      return reply.status(201).send(mem);
    },
  );

  // GET /v1/memory-stores/:id/memories/:m — retrieve memory (with content).
  app.get(
    "/v1/memory-stores/:id/memories/:m",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(req);
      const { id, m } = req.params as { id: string; m: string };
      const mem = await getMemory(pool, ctx, objectStore, id, m);
      return reply.status(200).send(mem);
    },
  );

  // PATCH /v1/memory-stores/:id/memories/:m — update (optimistic concurrency).
  app.patch(
    "/v1/memory-stores/:id/memories/:m",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(req);
      const { id, m } = req.params as { id: string; m: string };
      const parsed = MemoryUpdate.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(422, "invalid_request", zodMessage(parsed.error.issues));
      }
      const mem = await updateMemory(pool, ctx, objectStore, id, m, parsed.data);
      return reply.status(200).send(mem);
    },
  );

  // DELETE /v1/memory-stores/:id/memories/:m — delete memory.
  app.delete(
    "/v1/memory-stores/:id/memories/:m",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(req);
      const { id, m } = req.params as { id: string; m: string };
      await deleteMemory(pool, ctx, id, m);
      return reply.status(204).send();
    },
  );

  // GET /v1/memory-stores/:id/versions — list versions (audit trail).
  app.get(
    "/v1/memory-stores/:id/versions",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(req);
      const { id } = req.params as { id: string };
      const { limit, cursor } = parseListParams(req);
      const q = (req.query ?? {}) as { memoryPath?: string };
      const result = await listMemoryVersions(pool, ctx, id, {
        limit,
        cursor,
        memoryPath: q.memoryPath,
      });
      return reply
        .status(200)
        .send(paginate(result.data, result.nextCursor ?? undefined));
    },
  );

  // GET /v1/memory-stores/:id/versions/:v — retrieve a version.
  app.get(
    "/v1/memory-stores/:id/versions/:v",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(req);
      const { id, v } = req.params as { id: string; v: string };
      const version = await getMemoryVersion(pool, ctx, id, v);
      if (!version) {
        throw new ApiError(404, "not_found", `memory version not found: ${v}`);
      }
      return reply.status(200).send(version);
    },
  );

  // POST /v1/memory-stores/:id/versions/:v/redact — redact (scrub content, keep audit).
  app.post(
    "/v1/memory-stores/:id/versions/:v/redact",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(req);
      requireIdempotencyKey(req);
      const { id, v } = req.params as { id: string; v: string };
      const parsed = MemoryVersionRedactRequest.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new ApiError(422, "invalid_request", zodMessage(parsed.error.issues));
      }
      const version = await redactVersion(pool, ctx, objectStore, id, v);
      return reply.status(200).send(version);
    },
  );
};
