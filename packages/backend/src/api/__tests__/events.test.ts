/**
 * Events API HTTP tests (WP-1.7, §"Events & SSE"; R4.4).
 *
 * Uses a minimal Fastify app (event routes only + an onRequest hook that injects a
 * tenant context) backed by fakes — no Postgres / no Pi AgentSession. Covers:
 *  - POST /events: 202, Idempotency-Key required, 422 on invalid body,
 *    system.message 409 while idle+requires_action.
 *  - GET /events: paginated persisted history — read from the `session_events` projection
 *    seam (R4.4), never from a runtime.
 *  - GET /stream: 200 text/event-stream; projection replay + live delta frames over HTTP;
 *    a session with no ACTIVE runtime streams history only (nothing is woken).
 *  - Interrupt round-trip: POST user.interrupt → session.status_idle on the stream.
 *
 * The end-to-end read-path proof (real pool + a spy SandboxProvider that must never be
 * called) is `domain/session-manager/__tests__/read-path.integration.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import pino from "pino";
import { FakeSessionRuntime } from "@pi-managed/testkit";
import type {
  InboundEvent,
  OutboundEvent,
  SessionEntry,
  SessionRuntime,
} from "../../domain/ports.js";
import type { Session } from "@pi-managed/contracts";
import type { TenantCtx } from "../../infra/db/index.js";
import { FakeEventsReader } from "../../domain/event-stream/__tests__/fake-events-reader.js";
import { eventRoutes, type EventRoutesOptions } from "../events.js";
import { ApiError } from "../../domain/errors.js";

const SID = "sess_test";
// scopes: ["admin"] — this fixture bypasses issueApiKey (injects tenantCtx
// directly via an onRequest hook) so it must carry a scope explicitly to pass
// the requireScopeByMethod guard (R0.1) that eventRoutes registers.
const CTX: TenantCtx = { tenantId: "tnt_test", apiKeyId: "apikey_test", scopes: ["admin"] };

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: SID,
    agentId: "agent_x",
    agentVersion: 1,
    environmentId: "env_x",
    status: "idle",
    stopReason: null,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    vaultIds: [],
    resources: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    forkedFromSessionId: null,
    ...overrides,
  };
}

/**
 * Fake runtime whose `subscribe()` yields a pre-set list then ENDS (so SSE under
 * `app.inject` resolves instead of blocking forever).
 */
class FiniteFake extends FakeSessionRuntime {
  private live: OutboundEvent[] = [];
  override queueOutbound(...events: OutboundEvent[]): void {
    for (const e of events) this.live.push(e);
  }
  override subscribe(): AsyncIterable<OutboundEvent> {
    const out = this.live;
    return (async function* gen(): AsyncIterable<OutboundEvent> {
      for (const e of out) yield e;
    })();
  }
}

/**
 * Controllable fake: `subscribe()` drains queued events, then blocks on a waiter
 * (supports late `queueOutbound`) until `finish()` ends the stream. Mirrors the
 * real runtime's wait-pump shape but is cancellable from the test.
 */
class ControllableFake extends FakeSessionRuntime {
  private live: OutboundEvent[] = [];
  private waiter: ((e: OutboundEvent | null) => void) | null = null;
  override queueOutbound(...events: OutboundEvent[]): void {
    for (const e of events) this.live.push(e);
    this.pump();
  }
  private pump(): void {
    if (this.waiter && this.live.length > 0) {
      const e = this.live.shift()!;
      const w = this.waiter;
      this.waiter = null;
      w(e);
    }
  }
  /** End the live stream (resolves the pending waiter with null). */
  finish(): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(null);
    }
  }
  override subscribe(): AsyncIterable<OutboundEvent> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    async function* gen(): AsyncIterable<OutboundEvent> {
      while (self.live.length > 0) yield self.live.shift()!;
      while (true) {
        const next = await new Promise<OutboundEvent | null>((resolve) => {
          self.waiter = resolve;
          self.pump();
        });
        if (next === null) break;
        yield next;
      }
    }
    return gen();
  }
}

/** Fake that, on `user.interrupt`, calls `interrupt()` and emits `session.status_idle`. */
class InterruptingFake extends ControllableFake {
  override async sendEvent(event: InboundEvent): Promise<void> {
    await super.sendEvent(event);
    if (event.type === "user.interrupt") {
      await this.interrupt();
      this.queueOutbound({
        type: "session.status_idle",
        id: "evt_idle",
        createdAt: "2026-01-01T00:00:00.000Z",
        payload: { stopReason: "user_interrupt" },
      });
    }
  }
}

function entry(position: number, type = "agent.message"): SessionEntry {
  return {
    position,
    type,
    id: `evt_${position}`,
    createdAt: `2026-01-01T00:00:0${position}.000Z`,
    payload: type === "agent.message" ? { content: `msg-${position}` } : {},
  };
}

interface BuildOpts {
  runtime: SessionRuntime;
  /** Session to return from the lookup; `null` to simulate not-found. Undefined → default fake session. */
  session?: Session | null;
  /** Persisted history (the `session_events` projection, R4.1) — the ONLY read source. */
  history?: SessionEntry[];
  /**
   * Whether a runtime is ALREADY ACTIVE for this session (R4.4). `false` ⇒ `getActiveRuntime`
   * returns undefined and `GET /stream` is history-only (no wake). Defaults to `true`.
   */
  active?: boolean;
}

async function buildApp(opts: BuildOpts): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (req) => {
    (req as unknown as { tenantCtx: TenantCtx }).tenantCtx = CTX;
  });
  // Mirror server.ts' ApiError → ErrorEnvelope mapping (the test app does not use createApp).
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.statusCode).send({
        error: { type: "request_error", code: err.code, message: err.message, requestId: "test" },
      });
    }
    return reply.status(500).send({ error: { type: "server_error", code: "internal_error", message: "internal error", requestId: "test" } });
  });
  const eventOpts: EventRoutesOptions = {
    resolveRuntime: () => Promise.resolve(opts.runtime),
    getActiveRuntime: () => (opts.active === false ? undefined : opts.runtime),
    events: new FakeEventsReader(opts.history ?? []),
    resolveSession: () => Promise.resolve(opts.session === undefined ? fakeSession() : opts.session),
    logger: pino({ level: "silent" }),
  };
  await app.register(eventRoutes, eventOpts);
  return app;
}

function parseFrames(text: string): Array<{ id?: number; event: string; data: unknown }> {
  const frames: Array<{ id?: number; event: string; data: unknown }> = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    let id: number | undefined;
    let event = "";
    let dataRaw = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("id: ")) id = Number(line.slice(4));
      else if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) dataRaw += line.slice(6);
    }
    frames.push({ id, event, data: dataRaw ? JSON.parse(dataRaw) : undefined });
  }
  return frames;
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe("Events API — POST /v1/sessions/:id/events", () => {
  let app: FastifyInstance;
  let runtime: FakeSessionRuntime;

  beforeAll(async () => {
    runtime = new FakeSessionRuntime();
    app = await buildApp({ runtime });
  });
  afterAll(async () => {
    await app.close();
  });

  it("requires an Idempotency-Key (400)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/sessions/${SID}/events`,
      payload: { type: "user.message", content: "hi" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("invalid_request");
  });

  it("rejects an invalid event body (422)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/sessions/${SID}/events`,
      headers: { "idempotency-key": "k1" },
      payload: { type: "user.message" },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error.code).toBe("invalid_request");
  });

  it("accepts a user.message and returns 202 {accepted:true}", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/sessions/${SID}/events`,
      headers: { "idempotency-key": "k2" },
      payload: { type: "user.message", content: "Fix the login bug" },
    });
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body)).toEqual({ accepted: true });
    expect(runtime.inboundEvents[0].type).toBe("user.message");
    expect((runtime.inboundEvents[0].payload as { content: string }).content).toBe("Fix the login bug");
  });

  it("404s when the session does not exist", async () => {
    const localApp = await buildApp({
      runtime,
      session: null,
    });
    const res = await localApp.inject({
      method: "POST",
      url: `/v1/sessions/${SID}/events`,
      headers: { "idempotency-key": "k3" },
      payload: { type: "user.message", content: "hi" },
    });
    expect(res.statusCode).toBe(404);
    await localApp.close();
  });
});

describe("Events API — system.message requires_action guard (409)", () => {
  it("409 while idle with stopReason requires_action", async () => {
    const app = await buildApp({
      runtime: new FakeSessionRuntime(),
      session: fakeSession({ status: "idle", stopReason: "requires_action" }),
    });
    const res = await app.inject({
      method: "POST",
      url: `/v1/sessions/${SID}/events`,
      headers: { "idempotency-key": "k1" },
      payload: { type: "system.message", content: "updated prompt" },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe("requires_action");
    await app.close();
  });

  it("202 while running (no requires_action guard)", async () => {
    const runtime = new FakeSessionRuntime();
    const app = await buildApp({
      runtime,
      session: fakeSession({ status: "running", stopReason: null }),
    });
    const res = await app.inject({
      method: "POST",
      url: `/v1/sessions/${SID}/events`,
      headers: { "idempotency-key": "k2" },
      payload: { type: "system.message", content: "updated prompt" },
    });
    expect(res.statusCode).toBe(202);
    expect(runtime.inboundEvents[0].type).toBe("system.message");
    await app.close();
  });

  it("202 while idle with a non-requires_action stopReason", async () => {
    const app = await buildApp({
      runtime: new FakeSessionRuntime(),
      session: fakeSession({ status: "idle", stopReason: "completed" }),
    });
    const res = await app.inject({
      method: "POST",
      url: `/v1/sessions/${SID}/events`,
      headers: { "idempotency-key": "k3" },
      payload: { type: "system.message", content: "updated prompt" },
    });
    expect(res.statusCode).toBe(202);
    await app.close();
  });
});

describe("Events API — user.message not-idle guard (409, ROB-5)", () => {
  it("409 session_not_idle when a user.message arrives while running", async () => {
    const runtime = new FakeSessionRuntime();
    const app = await buildApp({
      runtime,
      session: fakeSession({ status: "running", stopReason: null }),
    });
    const res = await app.inject({
      method: "POST",
      url: `/v1/sessions/${SID}/events`,
      headers: { "idempotency-key": "concurrent-1" },
      payload: { type: "user.message", content: "second turn" },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe("session_not_idle");
    // The concurrent turn was rejected before ever reaching the runtime.
    expect(runtime.inboundEvents).toHaveLength(0);
    await app.close();
  });

  it("409 session_not_idle while rescheduling", async () => {
    const app = await buildApp({
      runtime: new FakeSessionRuntime(),
      session: fakeSession({ status: "rescheduling", stopReason: null }),
    });
    const res = await app.inject({
      method: "POST",
      url: `/v1/sessions/${SID}/events`,
      headers: { "idempotency-key": "concurrent-2" },
      payload: { type: "user.message", content: "hi" },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe("session_not_idle");
    await app.close();
  });

  it("202 when idle (the normal path)", async () => {
    const runtime = new FakeSessionRuntime();
    const app = await buildApp({
      runtime,
      session: fakeSession({ status: "idle", stopReason: "completed" }),
    });
    const res = await app.inject({
      method: "POST",
      url: `/v1/sessions/${SID}/events`,
      headers: { "idempotency-key": "idle-ok" },
      payload: { type: "user.message", content: "go" },
    });
    expect(res.statusCode).toBe(202);
    expect(runtime.inboundEvents[0].type).toBe("user.message");
    await app.close();
  });
});

describe("Events API — GET /v1/sessions/:id/events (history)", () => {
  it("returns paginated persisted history with seq + processedAt", async () => {
    const runtime = new FakeSessionRuntime();
    const app = await buildApp({
      runtime,
      history: [entry(0), entry(1), entry(2), entry(3), entry(4)],
    });
    const res = await app.inject({
      method: "GET",
      url: `/v1/sessions/${SID}/events?limit=2`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.map((d: { seq: number }) => d.seq)).toEqual([0, 1]);
    expect(body.data[0]).toMatchObject({ seq: 0, type: "agent.message", processedAt: "2026-01-01T00:00:00.000Z" });
    expect(body.nextCursor).toBeTypeOf("string");
    await app.close();
  });

  it("paginates via cursor (gap-free by position)", async () => {
    const runtime = new FakeSessionRuntime();
    const app = await buildApp({
      runtime,
      history: [entry(0), entry(1), entry(2), entry(3), entry(4)],
    });
    const first = await app.inject({ method: "GET", url: `/v1/sessions/${SID}/events?limit=2` });
    const cursor = JSON.parse(first.body).nextCursor;
    const second = await app.inject({
      method: "GET",
      url: `/v1/sessions/${SID}/events?limit=2&cursor=${cursor}`,
    });
    expect(JSON.parse(second.body).data.map((d: { seq: number }) => d.seq)).toEqual([2, 3]);
    await app.close();
  });
});

describe("Events API — GET /v1/sessions/:id/stream (SSE)", () => {
  it("returns text/event-stream with replayed frames (gap-free, delta-free)", async () => {
    const runtime = new FiniteFake();
    // No live outbound → subscribe ends immediately after replay; the stream resolves.
    const app = await buildApp({
      runtime,
      history: [entry(0), entry(1), entry(2), entry(3), entry(4)],
    });
    const res = await app.inject({
      method: "GET",
      url: `/v1/sessions/${SID}/stream`,
      headers: { "Last-Event-ID": "1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.headers["cache-control"]).toBe("no-cache");
    const frames = parseFrames(res.body);
    expect(frames.map((f) => f.id)).toEqual([2, 3, 4]);
    for (const f of frames) {
      expect(f.event).not.toBe("event_start");
      expect(f.event).not.toBe("event_delta");
    }
    await app.close();
  });

  it("emits event_start/event_delta for opted-in live agent.message", async () => {
    const runtime = new FiniteFake();
    runtime.queueOutbound({
      type: "agent.message",
      id: "evt_live",
      createdAt: "2026-01-01T00:00:10.000Z",
      payload: { content: "hello" },
    });
    const app = await buildApp({ runtime, history: [entry(0), entry(1)] });
    const res = await app.inject({
      method: "GET",
      url: `/v1/sessions/${SID}/stream?eventDeltas=agent.message`,
      headers: { "Last-Event-ID": "1" },
    });
    const frames = parseFrames(res.body);
    // Replay (seq 2) then live delta sequence + buffered (seq 2 — head was 2).
    const events = frames.map((f) => f.event);
    expect(events).toContain("event_start");
    expect(events).toContain("event_delta");
    expect(events).toContain("agent.message");
    const buffered = frames.find((f) => f.event === "agent.message");
    expect(buffered?.id).toBe(2);
    await app.close();
  });

  it("no eventDeltas → only buffered live events", async () => {
    const runtime = new FiniteFake();
    runtime.queueOutbound({
      type: "agent.message",
      id: "evt_live",
      createdAt: "2026-01-01T00:00:10.000Z",
      payload: { content: "hello" },
    });
    const app = await buildApp({ runtime });
    const res = await app.inject({ method: "GET", url: `/v1/sessions/${SID}/stream` });
    const events = parseFrames(res.body).map((f) => f.event);
    expect(events).toEqual(["agent.message"]);
    await app.close();
  });

  it("no ACTIVE runtime (R4.4): history replays, no live tail, nothing is subscribed", async () => {
    const runtime = new FiniteFake();
    runtime.queueOutbound({
      type: "agent.message",
      id: "evt_live",
      createdAt: "2026-01-01T00:00:10.000Z",
      payload: { content: "never-streamed" },
    });
    const app = await buildApp({
      runtime,
      active: false, // cold / completed / archived session — must not be woken
      history: [entry(0), entry(1), entry(2)],
    });
    const res = await app.inject({
      method: "GET",
      url: `/v1/sessions/${SID}/stream`,
      headers: { "Last-Event-ID": "0" },
    });
    expect(res.statusCode).toBe(200);
    const frames = parseFrames(res.body);
    expect(frames.map((f) => f.id)).toEqual([1, 2]);
    // The runtime's live queue was never touched: no subscriber was attached.
    expect(frames.some((f) => (f.data as { content?: string })?.content === "never-streamed")).toBe(false);
    await app.close();
  });
});

describe("Events API — interrupt round-trip", () => {
  it("POST user.interrupt → runtime interrupts → session.status_idle emitted on stream", async () => {
    const runtime = new InterruptingFake();
    const app = await buildApp({
      runtime,
      session: fakeSession({ status: "running", stopReason: null }),
    });

    // Open the stream first; let it reach the live subscribe wait.
    const streamP = app.inject({ method: "GET", url: `/v1/sessions/${SID}/stream` });
    await flush();

    const postRes = await app.inject({
      method: "POST",
      url: `/v1/sessions/${SID}/events`,
      headers: { "idempotency-key": "intr-1" },
      payload: { type: "user.interrupt" },
    });
    expect(postRes.statusCode).toBe(202);
    expect(runtime.inboundEvents[0].type).toBe("user.interrupt");
    expect(runtime.interruptCount).toBe(1);

    await flush();
    runtime.finish();
    const streamRes = await streamP;
    expect(streamRes.statusCode).toBe(200);
    const frames = parseFrames(streamRes.body);
    const idle = frames.find((f) => f.event === "session.status_idle");
    expect(idle).toBeDefined();
    expect((idle?.data as Record<string, unknown>).stopReason).toBe("user_interrupt");
    await app.close();
  });
});
