// @vitest-environment node
/**
 * Phase-2 gate — the W3+W4 end-to-end journey the phase gate names in the
 * implementation plan: delegate → watch live → hit `always_ask` → answer
 * from the console → outputs downloaded. One session, one REAL backend —
 * real Postgres (testcontainer), real Fastify app, the real global `fetch`,
 * real cookie console sessions with the real CSRF header on the write
 * (CONVENTIONS.md "Fakes at the seam").
 *
 * The session manager and the microsandbox are the shared scripted
 * COLLABORATORS from `src/api/__tests__/collaborators.ts`, wired through the
 * backend's own documented `CreateAppOptions` seams — the same mechanics the
 * WP-C2.2 (`session-events.contract.test.ts`) and WP-C2.3
 * (`sessions-fork.contract.test.ts`) contract suites use; every request and
 * frame crosses the real routes, the real SSE pipeline, and the real wire.
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
  FilesystemObjectStore,
  tenantScopedQuery,
  type SessionSandboxResolver,
} from "@pi-managed/backend";

import { ConsoleApiClient } from "../../src/api/client.js";
import { sendSessionEvent } from "../../src/api/session-events.js";
import {
  getSession,
  listSessionOutputs,
  listSessions,
  sessionOutputDownloadUrl,
} from "../../src/api/sessions.js";
import {
  streamSessionEvents,
  type SseFrame,
} from "../../src/api/stream.js";
import {
  ConfirmingRuntime,
  InMemoryProjection,
  ScriptedOutputsSandbox,
  seedSession,
  signInCookie,
  until,
} from "../../src/api/__tests__/collaborators.js";
import {
  requireContainers,
  startTestBackend,
  type TestBackend,
} from "../../src/api/__tests__/harness.js";

const RUNTIME = requireContainers("phase-2 gate: W3+W4 journey");

const BLOCKING_EVENT_ID = "evt_01GATEBLOCK";
const REPORT = "# Cleanup report\nremoved 12 stale artifacts\n";

describe.skipIf(!RUNTIME)("W3+W4 — delegate → watch live → always_ask → answer → outputs", () => {
  let backend: TestBackend;
  /** Cookie client for a write-capable console session (the answering user). */
  let writer: ConsoleApiClient;
  /** Cookie client for a read-scoped console session (watching + reads). */
  let reader: ConsoleApiClient;
  let readCookie: string;
  let session: Session;
  const projection = new InMemoryProjection();
  const runtime = new ConfirmingRuntime();
  const sandbox = new ScriptedOutputsSandbox();

  /** Emit like production: persist to the projection, then the live tail. */
  function emit(type: string, payload: unknown): void {
    const entry = projection.append(session.id, type, payload);
    runtime.emit({
      type,
      id: entry.id,
      createdAt: entry.createdAt,
      payload,
      position: entry.position,
    });
  }

  /** The WP-C2.0 seeding shape: flip the session row's status/stop_reason. */
  async function setSessionState(
    status: string,
    stopReason: string | null,
  ): Promise<void> {
    await tenantScopedQuery(
      backend.pool,
      { tenantId: backend.tenantId },
      `UPDATE sessions
          SET status = $3, stop_reason = $4, updated_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [backend.tenantId, session.id, status, stopReason],
    );
  }

  beforeAll(async () => {
    backend = await startTestBackend({
      app: {
        resolveRuntime: async () => runtime,
        getActiveRuntime: (sessionId) =>
          session && sessionId === session.id ? runtime : undefined,
        sessionEvents: projection.reader,
        // The Files API block that carries the outputs routes mounts only
        // with an object store present (server.ts WP-1.12 block).
        objectStore: new FilesystemObjectStore({
          root: mkdtempSync(join(tmpdir(), "pi-gate-journey-")),
        }),
        sandboxProvider: sandbox,
        sandboxResolver: {
          resolve: async (_ctx, sessionId) => ({
            id: `fake-${sessionId}`,
            name: `fake-${sessionId}`,
            labels: { tenant: backend.tenantId, session: sessionId },
          }),
        } satisfies SessionSandboxResolver,
      },
    });
    const admin = new ConsoleApiClient({
      baseUrl: backend.baseUrl,
      headers: { Authorization: `Bearer ${backend.adminKey}` },
    });
    // "Delegate": the session exists server-side (the CLI's /remote:delegate
    // creates it the same way, then prints the console deep link, C§1.4).
    session = await seedSession(admin, "gate-journey");

    writer = new ConsoleApiClient({
      baseUrl: backend.baseUrl,
      headers: { Cookie: await signInCookie(backend.baseUrl, backend.adminKey) },
    });
    readCookie = await signInCookie(backend.baseUrl, backend.readKey);
    reader = new ConsoleApiClient({
      baseUrl: backend.baseUrl,
      headers: { Cookie: readCookie },
    });
  }, 180_000);

  afterAll(async () => {
    if (backend) await backend.stop();
  }, 120_000);

  it(
    "the full journey, observed on ONE open stream",
    { timeout: 60_000 },
    async () => {
      // ── Watch live: the console's stream is open before anything happens.
      const frames: SseFrame[] = [];
      const controller = new AbortController();
      const done = streamSessionEvents(
        session.id,
        { onFrame: (f) => frames.push(f) },
        {
          signal: controller.signal,
          baseUrl: backend.baseUrl,
          headers: { Cookie: readCookie },
        },
      );

      // ── The delegated run reaches an `always_ask` tool: blocking request.
      emit("user.message", { content: "clean the workspace, write a report" });
      emit("agent.tool_use", {
        tool: "bash",
        input: { command: "rm -rf build/" },
        eventId: BLOCKING_EVENT_ID,
      });
      emit("session.status_idle", {
        stopReason: "requires_action",
        blockingEventIds: [BLOCKING_EVENT_ID],
      });
      await setSessionState("idle", "requires_action");
      await until(() => frames.length === 3); // …all seen live in the console.

      // §7.5 wire: the waiting session surfaces through the server-side
      // filter that feeds the sidebar badge + Home section.
      const waiting = await listSessions(
        { stopReason: "requires_action" },
        reader,
      );
      expect(waiting.data.map((s) => s.id)).toContain(session.id);

      // ── The manager's scripted reaction to the approval (§9.5): persist
      // the confirmation, resume the run, finish it, leave an output file.
      runtime.onEvent = async (event) => {
        if (event.type !== "user.tool_confirmation") return;
        emit(event.type, event.payload);
        await setSessionState("running", null);
        emit("session.status_run_started", {});
        emit("agent.tool_result", { tool: "bash", output: "removed build/" });
        sandbox.files.set("report.md", REPORT);
        await setSessionState("idle", "completed");
        emit("session.status_idle", { stopReason: "completed" });
      };

      // ── Answer from the console: Approve → user.tool_confirmation over
      // cookie + CSRF + auto Idempotency-Key.
      const accepted = await sendSessionEvent(
        session.id,
        {
          type: "user.tool_confirmation",
          eventId: BLOCKING_EVENT_ID,
          decision: "allow",
        },
        writer,
      );
      expect(accepted).toEqual({ accepted: true });

      // The whole resumption arrives on the ALREADY-OPEN stream, in order,
      // continuing the position ladder without a gap.
      await until(() => frames.length === 7);
      controller.abort();
      await done;
      expect(frames.map((f) => f.id)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(frames.map((f) => f.event)).toEqual([
        "user.message",
        "agent.tool_use",
        "session.status_idle",
        "user.tool_confirmation",
        "session.status_run_started",
        "agent.tool_result",
        "session.status_idle",
      ]);

      // ── The session finished; nothing waits for action anymore.
      const after = await getSession(session.id, reader);
      expect(after.status).toBe("idle");
      expect(after.stopReason).toBe("completed");
      expect(
        (await listSessions({ stopReason: "requires_action" }, reader)).data,
      ).toEqual([]);

      // ── Outputs downloaded: listing over the cookie session, then the
      // download exactly as the Outputs tab's `<a href>` rides it — a
      // same-origin GET carrying ONLY the console-session cookie.
      const outputs = await listSessionOutputs(session.id, reader);
      expect(outputs.data.map((f) => f.name)).toEqual(["report.md"]);
      const download = await fetch(
        `${backend.baseUrl}${sessionOutputDownloadUrl(session.id, "report.md")}`,
        { headers: { Cookie: readCookie } },
      );
      expect(download.status).toBe(200);
      expect(download.headers.get("content-type")).toBe(
        "application/octet-stream",
      );
      expect(await download.text()).toBe(REPORT);
    },
  );
});
