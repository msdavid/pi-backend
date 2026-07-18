// @vitest-environment node
/**
 * Phase-2 gate — console-spec §13 item §8.1: stream drop → resume with no
 * missed and no duplicated entries, pinned at gate level against the REAL
 * backend — real Postgres (testcontainer), real Fastify app, the real global
 * `fetch`, a real cookie console session (CONVENTIONS.md "Fakes at the
 * seam"). The session-manager stand-ins come from the shared collaborators
 * module (`src/api/__tests__/collaborators.ts`) — the same ones the WP-C2.1
 * contract suite (`stream.contract.test.ts`) drives; that suite covers the
 * full ladder (replay, clean end, polling fallback) during development, this
 * gate pins the release conformance item.
 *
 * Run with `PI_REQUIRE_INTEGRATION=containers` so a missing container
 * runtime fails instead of silently skipping.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Session } from "@pi-managed/contracts";

import { ConsoleApiClient } from "../../src/api/client.js";
import {
  streamSessionEvents,
  type SessionStreamPhase,
  type SseFrame,
} from "../../src/api/stream.js";
import {
  InMemoryProjection,
  LiveTailRuntime,
  seedSession,
  signInCookie,
  until,
} from "../../src/api/__tests__/collaborators.js";
import {
  requireContainers,
  startTestBackend,
  type TestBackend,
} from "../../src/api/__tests__/harness.js";

const RUNTIME = requireContainers("phase-2 gate: §8.1 stream drop → resume");

describe.skipIf(!RUNTIME)("§8.1 — stream drop → resume, nothing missed, nothing duplicated", () => {
  let backend: TestBackend;
  let cookie: string;
  let session: Session;
  const projection = new InMemoryProjection();
  const runtime = new LiveTailRuntime();

  /** Emit like production: persist to the projection, then the live tail. */
  function emit(type: string, payload: unknown): void {
    const entry = projection.append(session.id, type, payload);
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
        resolveRuntime: async () => runtime,
        getActiveRuntime: (sessionId) =>
          session && sessionId === session.id ? runtime : undefined,
        sessionEvents: projection.reader,
      },
    });
    const admin = new ConsoleApiClient({
      baseUrl: backend.baseUrl,
      headers: { Authorization: `Bearer ${backend.adminKey}` },
    });
    session = await seedSession(admin, "gate-stream-resume");
    cookie = await signInCookie(backend.baseUrl, backend.readKey);
  }, 180_000);

  afterAll(async () => {
    if (backend) await backend.stop();
  }, 120_000);

  it(
    "connection killed mid-stream → Last-Event-ID resume completes the position ladder exactly once",
    { timeout: 30_000 },
    async () => {
      // Two persisted events before the client ever connects (replayed).
      emit("user.message", { content: "start" });
      emit("agent.thinking", { signature: "s1" });

      const frames: SseFrame[] = [];
      const phases: SessionStreamPhase[] = [];
      const controller = new AbortController();
      const done = streamSessionEvents(
        session.id,
        {
          onFrame: (f) => frames.push(f),
          onPhase: (p) => phases.push(p),
        },
        {
          signal: controller.signal,
          baseUrl: backend.baseUrl,
          headers: { Cookie: cookie },
          backoffMs: 10,
        },
      );
      await until(() => frames.length === 2); // replay
      emit("agent.tool_use", { tool: "bash", input: {} });
      await until(() => frames.length === 3); // live tail

      // Kill every open connection at the socket level — a mid-stream drop,
      // not a clean end.
      backend.app.server.closeAllConnections();
      // An event emitted while the client is disconnected: the reconnect
      // replay (Last-Event-ID = 2) must deliver it from the projection.
      emit("agent.tool_result", { tool: "bash", output: "ok" });

      await until(() => frames.length === 4);
      // And the live tail continues after the resume.
      emit("agent.message", { content: "done" });
      await until(() => frames.length === 5);

      controller.abort();
      await done;

      // The §13 assertion: the position ladder is complete and duplicate-free.
      expect(frames.map((f) => f.id)).toEqual([0, 1, 2, 3, 4]);
      expect(frames.map((f) => f.event)).toEqual([
        "user.message",
        "agent.thinking",
        "agent.tool_use",
        "agent.tool_result",
        "agent.message",
      ]);
      // It reconnected (two live phases), never degraded to polling.
      expect(phases.filter((p) => p === "live")).toHaveLength(2);
      expect(phases).not.toContain("polling");
    },
  );
});
