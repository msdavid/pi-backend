// @vitest-environment node
/**
 * SSE streaming seam tests (WP-C2.1 acceptance; console-spec §8.1, §13 item
 * 8.1): the console stream client against the REAL backend over real HTTP —
 * real Postgres (testcontainer), real Fastify app, the real global `fetch`,
 * the real cookie console session (CONVENTIONS.md "Fakes at the seam": the
 * client↔server wire is the subject, so both sides are real).
 *
 * The events surface is wired through the SAME documented seams the
 * composition root uses (`CreateAppOptions.sessionEvents` /
 * `getActiveRuntime` / `resolveRuntime` — `server.ts` mounts the Events API
 * through them): a scripted projection reader + a minimal live-tail runtime
 * are COLLABORATORS standing in for the session manager, exactly like
 * `backend/src/api/__tests__/events.test.ts` drives the same routes. Every
 * frame still crosses the real SSE pipeline (`pipeSessionStream`: replay
 * paging, live/replay dedupe by position, hijacked reply) and the real wire.
 *
 * Covers:
 *  - cookie-authed connect (§4.3 — the global auth middleware guards the
 *    stream route; no Authorization header anywhere near these requests);
 *  - full-history replay on first connect, clean end without a live runtime;
 *  - the §13 item: kill the connection mid-stream → reconnect with
 *    `Last-Event-ID` → resume with NO missed and NO duplicated entries,
 *    including an event emitted while the client was disconnected;
 *  - the degradation ladder: a backend without the stream route (the events
 *    surface unmounted) → entries polling, with entries still advancing.
 *
 * Run with `PI_REQUIRE_INTEGRATION=containers` so a missing container
 * runtime fails instead of silently skipping.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Session } from "@pi-managed/contracts";
import {
  fetchSessionRow,
  FilesystemObjectStore,
} from "@pi-managed/backend";

import { ConsoleApiClient } from "../client.js";
import {
  streamSessionEvents,
  type SessionStreamOptions,
  type SessionStreamPhase,
  type SseFrame,
} from "../stream.js";
import {
  InMemoryProjection,
  LiveTailRuntime,
  seedSession,
  signInCookie,
  until,
} from "./collaborators.js";
import {
  requireContainers,
  startTestBackend,
  type TestBackend,
} from "./harness.js";

const RUNTIME = requireContainers("web-console SSE stream contract suite");

interface Collected {
  frames: SseFrame[];
  phases: SessionStreamPhase[];
  controller: AbortController;
  done: Promise<void>;
}

function collect(
  baseUrl: string,
  cookie: string,
  sessionId: string,
  opts: Partial<SessionStreamOptions> = {},
): Collected {
  const frames: SseFrame[] = [];
  const phases: SessionStreamPhase[] = [];
  const controller = new AbortController();
  const done = streamSessionEvents(
    sessionId,
    {
      onFrame: (f) => frames.push(f),
      onPhase: (p) => phases.push(p),
    },
    {
      signal: controller.signal,
      baseUrl,
      headers: { Cookie: cookie },
      ...opts,
    },
  );
  return { frames, phases, controller, done };
}

// ---------------------------------------------------------------------------
// Suite 1: replay + live tail + drop/resume (events surface wired)
// ---------------------------------------------------------------------------

describe.skipIf(!RUNTIME)("session stream ↔ real backend (replay/resume)", () => {
  let backend: TestBackend;
  let cookie: string;
  const projection = new InMemoryProjection();
  const runtime = new LiveTailRuntime();
  /** History-only session (no active runtime — clean end after replay). */
  let coldSession: Session;
  /** Session with the live-tail runtime attached. */
  let warmSession: Session;

  /** Emit like production: persist to the projection, then the live tail. */
  function emit(sessionId: string, type: string, payload: unknown): void {
    const entry = projection.append(sessionId, type, payload);
    runtime.push({
      type,
      id: entry.id,
      createdAt: entry.createdAt,
      payload,
      position: entry.position,
    });
  }

  beforeAll(async () => {
    backend = await startTestBackend({
      app: {
        // The advance path (POST /events) is not under test; mounting the
        // Events API just requires the resolver to exist.
        resolveRuntime: async () => runtime,
        getActiveRuntime: (sessionId) =>
          warmSession && sessionId === warmSession.id ? runtime : undefined,
        sessionEvents: projection.reader,
      },
    });
    const admin = new ConsoleApiClient({
      baseUrl: backend.baseUrl,
      headers: { Authorization: `Bearer ${backend.adminKey}` },
    });
    coldSession = await seedSession(admin, "stream-cold");
    warmSession = await seedSession(admin, "stream-warm");
    cookie = await signInCookie(backend.baseUrl, backend.readKey);
  }, 180_000);

  afterAll(async () => {
    if (backend) await backend.stop();
  }, 120_000);

  it(
    "cookie-only connect replays the full history and ends cleanly without a runtime",
    { timeout: 30_000 },
    async () => {
      projection.append(coldSession.id, "user.message", { content: "hello" });
      projection.append(coldSession.id, "agent.message", { content: "hi!" });
      projection.append(coldSession.id, "session.status_idle", {
        stopReason: "completed",
      });

      const c = collect(backend.baseUrl, cookie, coldSession.id);
      await c.done; // history-only: the server closes after replay

      expect(c.frames.map((f) => f.id)).toEqual([0, 1, 2]);
      expect(c.frames.map((f) => f.event)).toEqual([
        "user.message",
        "agent.message",
        "session.status_idle",
      ]);
      // The wire data is the flat contracts shape {type, …payload, processedAt}.
      expect(c.frames[0]!.data).toMatchObject({
        type: "user.message",
        content: "hello",
      });
      expect(c.phases).toEqual(["connecting", "live", "ended"]);
    },
  );

  it("rejects a stream connect with no credentials (401 — auth middleware is global)", async () => {
    const res = await fetch(
      `${backend.baseUrl}/v1/sessions/${coldSession.id}/stream`,
      { headers: { Accept: "text/event-stream" } },
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).not.toContain("text/event-stream");
  });

  it(
    "§13 item 8.1: connection killed mid-stream → resume from Last-Event-ID, nothing missed, nothing duplicated",
    { timeout: 30_000 },
    async () => {
      // Two persisted events before the client ever connects.
      emit(warmSession.id, "user.message", { content: "start" });
      emit(warmSession.id, "agent.thinking", { signature: "s1" });

      const c = collect(backend.baseUrl, cookie, warmSession.id, {
        backoffMs: 10,
      });
      await until(() => c.frames.length === 2); // replay
      emit(warmSession.id, "agent.tool_use", { tool: "bash", input: {} });
      await until(() => c.frames.length === 3); // live tail

      // Kill every open connection at the socket level — a mid-stream drop,
      // not a clean end.
      backend.app.server.closeAllConnections();
      // An event emitted while the client is disconnected: the reconnect
      // replay (Last-Event-ID = 2) must deliver it from the projection.
      emit(warmSession.id, "agent.tool_result", { tool: "bash", output: "ok" });

      await until(() => c.frames.length === 4);
      // And the live tail continues after the resume.
      emit(warmSession.id, "agent.message", { content: "done" });
      await until(() => c.frames.length === 5);

      c.controller.abort();
      await c.done;

      // The §13 assertion: the position ladder is complete and duplicate-free.
      expect(c.frames.map((f) => f.id)).toEqual([0, 1, 2, 3, 4]);
      expect(c.frames.map((f) => f.event)).toEqual([
        "user.message",
        "agent.thinking",
        "agent.tool_use",
        "agent.tool_result",
        "agent.message",
      ]);
      // It reconnected (two live phases), never degraded to polling.
      expect(c.phases.filter((p) => p === "live")).toHaveLength(2);
      expect(c.phases).not.toContain("polling");
    },
  );
});

// ---------------------------------------------------------------------------
// Suite 2: polling fallback (backend WITHOUT the events surface — the stream
// route is not mounted, so SSE is unusable; entries still advance)
// ---------------------------------------------------------------------------

describe.skipIf(!RUNTIME)("session stream ↔ real backend (polling fallback)", () => {
  let backend: TestBackend;
  let cookie: string;
  let session: Session;
  let store: FilesystemObjectStore;
  let jsonlKey: string;

  /** JSONL log lines (the entries read is JSONL-backed, `seq` = line index). */
  const lines: string[] = [
    JSON.stringify({
      type: "user.message",
      id: "e1",
      timestamp: "2026-07-13T12:00:00Z",
      content: "hi",
    }),
    JSON.stringify({
      type: "agent.message",
      id: "e2",
      timestamp: "2026-07-13T12:00:01Z",
      content: "hello",
    }),
  ];

  async function writeLog(): Promise<void> {
    const text = `${lines.join("\n")}\n`;
    const bytes = new TextEncoder().encode(text);
    await store.put(
      jsonlKey,
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    );
  }

  beforeAll(async () => {
    store = new FilesystemObjectStore({
      root: mkdtempSync(join(tmpdir(), "pi-console-stream-jsonl-")),
    });
    // No `resolveRuntime` ⇒ the Events API (stream included) is NOT mounted:
    // GET /v1/sessions/:id/stream 404s, exactly the "SSE unusable" case.
    backend = await startTestBackend({ app: { objectStore: store } });
    const admin = new ConsoleApiClient({
      baseUrl: backend.baseUrl,
      headers: { Authorization: `Bearer ${backend.adminKey}` },
    });
    session = await seedSession(admin, "stream-poll");
    const row = await fetchSessionRow(
      backend.pool,
      { tenantId: backend.tenantId },
      session.id,
    );
    jsonlKey = (row as { jsonl_object_key: string }).jsonl_object_key;
    await writeLog();
    cookie = await signInCookie(backend.baseUrl, backend.readKey);
  }, 180_000);

  afterAll(async () => {
    if (backend) await backend.stop();
  }, 120_000);

  it(
    "degrades to entries polling after N failed connects; entries keep advancing",
    { timeout: 30_000 },
    async () => {
      const c = collect(backend.baseUrl, cookie, session.id, {
        maxConnectFailures: 2,
        backoffMs: 10,
        pollIntervalMs: 50,
      });

      await until(() => c.frames.length === 2);
      expect(c.phases).toContain("polling");
      expect(c.phases).not.toContain("live");

      // The session does more work: the log grows → the next poll picks it
      // up positionally (`?from=2`), no re-delivery of seq 0–1.
      lines.push(
        JSON.stringify({
          type: "session.status_idle",
          id: "e3",
          timestamp: "2026-07-13T12:00:02Z",
          stopReason: "completed",
        }),
      );
      await writeLog();
      await until(() => c.frames.length === 3);

      c.controller.abort();
      await c.done;

      expect(c.frames.map((f) => f.id)).toEqual([0, 1, 2]);
      expect(c.frames.map((f) => f.event)).toEqual([
        "user.message",
        "agent.message",
        "session.status_idle",
      ]);
      expect(c.frames[2]!.data).toMatchObject({
        seq: 2,
        type: "session.status_idle",
        processedAt: "2026-07-13T12:00:02Z",
      });
    },
  );
});
