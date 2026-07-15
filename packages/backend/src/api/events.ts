/**
 * Events API routes (WP-1.7, §"Events & SSE"; R4.4). The send/stream surface.
 *
 * - `POST /v1/sessions/:id/events` — send a `user.*` / `system.*` event
 *   (`Idempotency-Key` required). `user.message` starts/continues;
 *   `user.interrupt` redirects; `system.message` is rejected with `409
 *   requires_action` while the session is idle with
 *   `stopReason: requires_action`.
 * - `GET  /v1/sessions/:id/events` — paginated persisted-event history.
 * - `GET  /v1/sessions/:id/stream`  — SSE (replay + live tail + optional event deltas).
 *   With `Last-Event-ID`, replay resumes gap-free right after it. Without one (first
 *   connect), replay serves the FULL persisted history from position 0 — optionally bounded
 *   by `?from=<position>` — before the live tail attaches, so a subscriber that connects
 *   after an event was emitted still receives it.
 *
 * **Read/advance split (R4.4).** Advancing a session (`POST /events`) resolves a live
 * runtime via `resolveRuntime`, which wakes it and provisions its sandbox. *Reading* one
 * never does: history and the reconnect replay are served from the `session_events`
 * projection (R4.1) via the {@link EventsReader} seam — a plain Postgres query — and the
 * live SSE tail attaches ONLY to an already-active runtime (`getActiveRuntime`). Reading a
 * completed / archived session therefore provisions ZERO sandboxes, and an archived
 * session's history stays readable while `POST /events` still 404s on it.
 *
 * Session existence/tenancy is resolved via `getSession` (advance) / `fetchSessionRow`
 * (read — archived included). Validation is delegated to the `@pi-managed/contracts` zod
 * schemas.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { requireScopeByMethod } from "./middleware/scope.js";
import type { Logger } from "pino";
import { InboundEvent, type Session } from "@pi-managed/contracts";
import { type Pool, type TenantCtx } from "../infra/db/index.js";
import { ApiError } from "../domain/errors.js";
import { parseListParams, paginate, encodeCursor, decodeCursor } from "./middleware/pagination.js";
import type { SessionRuntime } from "../domain/ports.js";
import { fetchSessionRow, getSession, toSession } from "../domain/session/index.js";
import { SessionEventsStore } from "../domain/session-manager/index.js";
import {
  inboundToPorts,
  entryToHistoryItem,
  parseEventDeltas,
  pipeSessionStream,
  type EventsReader,
} from "../domain/event-stream/index.js";

/** Options for {@link eventRoutes}. */
export interface EventRoutesOptions {
  /** Postgres pool — used for the default session lookup + events reader. Required unless both are provided. */
  pool?: Pool;
  /**
   * Resolve the live runtime for a session — the ADVANCE path (`POST /events`). May wake
   * the session and provision its sandbox. The runtime registry is external.
   */
  resolveRuntime: (sessionId: string) => Promise<SessionRuntime>;
  /**
   * The ALREADY-ACTIVE runtime for a session, or `undefined` — the live SSE tail (R4.4).
   * Must never wake one. Omitted ⇒ `GET /stream` is history-only (replay, then end).
   */
  getActiveRuntime?: (sessionId: string) => SessionRuntime | undefined;
  /**
   * The `session_events` projection reader (R4.1) that serves history + replay (R4.4).
   * Defaults to a pool-backed {@link SessionEventsStore}. Reads never touch a runtime.
   */
  events?: EventsReader;
  /**
   * Optional override for session lookup (test seam). Defaults to `getSession(pool, ctx,
   * id)` for the advance path (cross-tenant / archived → `null` → 404) and
   * `fetchSessionRow` for the read path (archived history stays readable, R4.4). When
   * supplied, it is used for BOTH paths.
   */
  resolveSession?: (ctx: TenantCtx, id: string) => Promise<Session | null>;
  /** Optional logger for surfacing async send/stream errors. */
  logger?: Logger;
}

/** Adapt the pool-backed projection store to the {@link EventsReader} seam. */
function storeReader(store: SessionEventsStore): EventsReader {
  return {
    readEvents: (_tenantId, sessionId, range) => store.read(sessionId, range),
    readEventsHead: (sessionId) => store.head(sessionId),
  };
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

/** Parse the `Last-Event-ID` header into a sequence position, or `undefined`. */
function parseLastEventId(req: FastifyRequest): number | undefined {
  const raw = req.headers["last-event-id"];
  if (!raw || Array.isArray(raw)) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : undefined;
}

/**
 * Parse the optional `?from=<position>` query param: bounds a first-connect replay (no
 * `Last-Event-ID`) so a client can skip a long history. Ignored once `Last-Event-ID` is
 * present — that header always takes precedence (R4.4 reconnect semantics).
 */
function parseFromPosition(req: FastifyRequest): number | undefined {
  const raw = (req.query as { from?: string } | null)?.from;
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : undefined;
}

export const eventRoutes: FastifyPluginAsync<EventRoutesOptions> = async (app, opts) => {
  // R0.1: enforce API-key scopes on every route in this plugin (GET/HEAD → read,
  // mutating → write; `admin` passes all; worker keys are denied here).
  app.addHook("preHandler", requireScopeByMethod);

  // The read side of the one event universe (R4.1/R4.4): history + replay come from the
  // `session_events` projection — the canonical numbered stream (§9.3) — read straight
  // from the pool. No runtime is resolved, so a read never boots a VM.
  const events: EventsReader | undefined =
    opts.events ?? (opts.pool ? storeReader(new SessionEventsStore(opts.pool)) : undefined);
  if (!events) {
    throw new Error("eventRoutes: either `pool` or `events` (the projection reader) is required");
  }

  /** Resolve a session for the ADVANCE path (archived → 404), or throw 404. */
  async function resolveSessionOr404(ctx: TenantCtx, id: string): Promise<Session> {
    const session = opts.resolveSession
      ? await opts.resolveSession(ctx, id)
      : await getSession(opts.pool!, ctx, id);
    if (!session) {
      throw new ApiError(404, "not_found", `session not found: ${id}`);
    }
    return session;
  }

  /**
   * Resolve a session for the READ path, or throw 404. Archived sessions are INCLUDED
   * (R4.4): their history is the audit record and stays readable — only advancing them
   * (`POST /events`) is rejected.
   */
  async function resolveReadableSessionOr404(ctx: TenantCtx, id: string): Promise<Session> {
    if (opts.resolveSession) return resolveSessionOr404(ctx, id);
    const row = await fetchSessionRow(opts.pool!, ctx, id);
    if (!row) {
      throw new ApiError(404, "not_found", `session not found: ${id}`);
    }
    return toSession(row);
  }

  // POST /v1/sessions/:id/events — send a user.* / system.* event.
  app.post("/v1/sessions/:id/events", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    requireIdempotencyKey(req);
    const { id } = req.params as { id: string };

    const parsed = InboundEvent.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(
        422,
        "invalid_request",
        `invalid event: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      );
    }
    const event = parsed.data;

    const session = await resolveSessionOr404(ctx, id);

    // ROB-5: a user.message may only start/continue a turn while the session is IDLE. A
    // second user.message arriving mid-turn (running / rescheduling) would drive a
    // concurrent turn that shares the runtime's single turn-flags slot, corrupting both.
    // Reject it (mirrors the system.message guard below) so the client retries once idle.
    if (event.type === "user.message" && session.status !== "idle") {
      throw new ApiError(
        409,
        "session_not_idle",
        `session is ${session.status}; wait for it to return to idle before sending another user.message`,
      );
    }

    // system.message cannot be sent while idle with stopReason: requires_action (§9.6).
    if (
      event.type === "system.message" &&
      session.status === "idle" &&
      session.stopReason === "requires_action"
    ) {
      throw new ApiError(
        409,
        "requires_action",
        "system.message cannot be sent while the session is idle with stopReason requires_action",
      );
    }

    const runtime = await opts.resolveRuntime(id);
    const portsEvent = inboundToPorts(event);
    // Work proceeds asynchronously (§9.1): return 202 once accepted; the runtime
    // drives the turn and emits outbound events on the stream.
    void runtime.sendEvent(portsEvent).catch((err) => {
      opts.logger?.error?.(
        { sessionId: id, err: err instanceof Error ? err.message : String(err) },
        "sendEvent failed",
      );
    });
    return reply.status(202).send({ accepted: true });
  });

  // GET /v1/sessions/:id/events — paginated persisted-event history (projection only).
  app.get("/v1/sessions/:id/events", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    await resolveReadableSessionOr404(ctx, id);

    const { limit, cursor } = parseListParams(req);
    let start: number | undefined;
    if (cursor) {
      try {
        const marker = decodeCursor<{ from?: number }>(cursor);
        start = typeof marker.from === "number" ? marker.from : undefined;
      } catch {
        throw new ApiError(400, "invalid_request", "invalid events cursor");
      }
    }

    // R4.4: the projection is the ONLY history source — no runtime, no sandbox.
    const entries = await events.readEvents(ctx.tenantId, id, { start, limit: limit + 1 });
    const hasMore = entries.length > limit;
    const page = hasMore ? entries.slice(0, limit) : entries;
    const data = page.map(entryToHistoryItem);
    const nextCursor =
      hasMore && page.length > 0
        ? encodeCursor({ from: (start ?? 0) + page.length })
        : undefined;
    return reply.status(200).send(paginate(data, nextCursor));
  });

  // GET /v1/sessions/:id/stream — SSE: replay from the projection, then the live tail of
  // an ALREADY-ACTIVE runtime (R4.4 — streaming a cold session wakes nothing).
  app.get("/v1/sessions/:id/stream", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    await resolveReadableSessionOr404(ctx, id);

    const runtime = opts.getActiveRuntime?.(id);
    const lastEventId = parseLastEventId(req);
    const fromPosition = parseFromPosition(req);
    const eventDeltas = parseEventDeltas((req.query as { eventDeltas?: string } | null)?.eventDeltas);

    // Hijack the reply for text/event-stream (Fastify supports raw streaming).
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // AbortSignal tied to the client connection.
    const controller = new AbortController();
    const onClose = (): void => controller.abort();
    req.raw.on("close", onClose);

    try {
      await pipeSessionStream(
        {
          events,
          tenantId: ctx.tenantId,
          sessionId: id,
          ...(runtime ? { runtime } : {}),
        },
        { lastEventId, fromPosition, eventDeltas, signal: controller.signal, logger: opts.logger },
        raw,
      );
    } finally {
      req.raw.off("close", onClose);
      if (!raw.writableEnded) raw.end();
    }
  });
};
