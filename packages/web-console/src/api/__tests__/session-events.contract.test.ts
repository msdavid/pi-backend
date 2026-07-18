// @vitest-environment node
/**
 * Steer / interrupt / confirm contract tests (WP-C2.2 acceptance: "seeded
 * `requires_action` session → confirm → status transition observed via
 * stream"): the inbound-event client against the REAL backend over real HTTP
 * — real Postgres (testcontainer), real Fastify app, the real global `fetch`,
 * a real cookie console session with the real CSRF header (CONVENTIONS.md
 * "Fakes at the seam": the client↔server wire is the subject, so both sides
 * are real).
 *
 * The events surface is wired through the SAME documented `CreateAppOptions`
 * seams the composition root uses (`resolveRuntime` / `getActiveRuntime` /
 * `sessionEvents`, exactly like `stream.contract.test.ts`); a scripted
 * runtime COLLABORATOR stands in for the session manager and mirrors its
 * confirmation behavior — persist the inbound event, flip the session row
 * back to `running`, emit `session.status_run_started` (§9.5: "returns the
 * session to running") — while every request and frame crosses the real
 * routes and the real SSE pipeline.
 *
 * Covers:
 *  - the W4 acceptance flow: a session seeded idle on
 *    `stopReason: requires_action` (same `updateSessionStatus`-shaped row
 *    update WP-C2.0's backend suite uses), `user.tool_confirmation` posted
 *    through the cookie-authed client (auto Idempotency-Key + CSRF header),
 *    `202 {accepted: true}`, and the transition observed on the OPEN §8
 *    stream (the confirmation + `session.status_run_started` frames continue
 *    the position ladder with no gap), with the detail read agreeing;
 *  - the §7.5 surfacing wire: `?stopReason=requires_action` narrows the
 *    cookie-read list before the confirmation and is empty after, and the
 *    list payload carries the WP-C2.0 `usage.usdCost` rollup;
 *  - `user.message` idle-only (`409 session_not_idle` while running) and
 *    `user.interrupt` accepted while running;
 *  - scope honesty behind the disabled-with-reason UI (§6.1/§6.4): the same
 *    post with a `read`-scoped cookie answers `403`.
 *
 * Run with `PI_REQUIRE_INTEGRATION=containers` so a missing container
 * runtime fails instead of silently skipping.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Session } from "@pi-managed/contracts";
import { tenantScopedQuery } from "@pi-managed/backend";

import { ConsoleApiClient, ConsoleApiError } from "../client.js";
import { sendSessionEvent } from "../session-events.js";
import { getSession, listSessions } from "../sessions.js";
import {
  streamSessionEvents,
  type SessionStreamPhase,
  type SseFrame,
} from "../stream.js";
import {
  ConfirmingRuntime,
  InMemoryProjection,
  seedSession,
  signInCookie,
  until,
} from "./collaborators.js";
import {
  requireContainers,
  startTestBackend,
  type TestBackend,
} from "./harness.js";

const RUNTIME = requireContainers("web-console session-events contract suite");

const BLOCKING_EVENT_ID = "evt_01TESTBLOCK";

describe.skipIf(!RUNTIME)("session events ↔ real backend (W4)", () => {
  let backend: TestBackend;
  /** Cookie client for an admin-scoped console session (the writing user). */
  let writer: ConsoleApiClient;
  /** Cookie client for a read-scoped console session (§6.1 honesty). */
  let reader: ConsoleApiClient;
  const projection = new InMemoryProjection();
  const runtime = new ConfirmingRuntime();
  let session: Session;

  /** Emit like production: persist to the projection, then the live tail. */
  function emit(sessionId: string, type: string, payload: unknown): void {
    const entry = projection.append(sessionId, type, payload);
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
      },
    });
    const admin = new ConsoleApiClient({
      baseUrl: backend.baseUrl,
      headers: { Authorization: `Bearer ${backend.adminKey}` },
    });
    session = await seedSession(admin, "confirm-flow");

    writer = new ConsoleApiClient({
      baseUrl: backend.baseUrl,
      headers: { Cookie: await signInCookie(backend.baseUrl, backend.adminKey) },
    });
    reader = new ConsoleApiClient({
      baseUrl: backend.baseUrl,
      headers: { Cookie: await signInCookie(backend.baseUrl, backend.readKey) },
    });
  }, 180_000);

  afterAll(async () => {
    if (backend) await backend.stop();
  }, 120_000);

  it(
    "W4 acceptance: requires_action → user.tool_confirmation → transition observed via the stream",
    { timeout: 30_000 },
    async () => {
      // ── Seed: the session stopped on a blocking always_ask tool request.
      emit(session.id, "user.message", { content: "clean the workspace" });
      emit(session.id, "agent.tool_use", {
        tool: "bash",
        input: { command: "rm -rf build/" },
        eventId: BLOCKING_EVENT_ID,
      });
      emit(session.id, "session.status_idle", {
        stopReason: "requires_action",
        blockingEventIds: [BLOCKING_EVENT_ID],
      });
      await setSessionState("idle", "requires_action");

      // §7.5 wire: the server-side filter surfaces exactly this session, and
      // the list payload carries the WP-C2.0 usdCost rollup (cookie read).
      const waiting = await listSessions(
        { stopReason: "requires_action" },
        reader,
      );
      expect(waiting.data.map((s) => s.id)).toEqual([session.id]);
      expect(waiting.data[0]!.usage.usdCost).toBe(0);

      // ── The manager's scripted reaction (§9.5): persist the confirmation,
      // return the session to running, emit the status event.
      runtime.onEvent = async (event) => {
        if (event.type !== "user.tool_confirmation") return;
        emit(session.id, event.type, event.payload);
        await setSessionState("running", null);
        emit(session.id, "session.status_run_started", {});
      };

      // ── Watch the session like the console does (§8 stream, cookie-only).
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
          headers: { Cookie: `${await signInCookie(backend.baseUrl, backend.readKey)}` },
        },
      );
      await until(() => frames.length === 3); // full-history replay

      // ── The console's Approve click: cookie + CSRF + auto Idempotency-Key.
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

      // The transition arrives on the ALREADY-OPEN stream: the persisted
      // confirmation + session.status_run_started continue the ladder.
      await until(() => frames.length === 5);
      controller.abort();
      await done;

      expect(frames.map((f) => f.id)).toEqual([0, 1, 2, 3, 4]);
      expect(frames.map((f) => f.event)).toEqual([
        "user.message",
        "agent.tool_use",
        "session.status_idle",
        "user.tool_confirmation",
        "session.status_run_started",
      ]);
      expect(frames[3]!.data).toMatchObject({
        type: "user.tool_confirmation",
        eventId: BLOCKING_EVENT_ID,
        decision: "allow",
      });

      // The detail read agrees, and the §7.5 filter empties out.
      const after = await getSession(session.id, reader);
      expect(after.status).toBe("running");
      expect(after.stopReason).toBeNull();
      const stillWaiting = await listSessions(
        { stopReason: "requires_action" },
        reader,
      );
      expect(stillWaiting.data).toEqual([]);
    },
  );

  it("user.message is idle-only: 409 session_not_idle while running", async () => {
    // The previous test left the session running — exactly the guard case.
    const err: unknown = await sendSessionEvent(
      session.id,
      { type: "user.message", content: "also update the changelog" },
      writer,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConsoleApiError);
    expect((err as ConsoleApiError).status).toBe(409);
    expect((err as ConsoleApiError).code).toBe("session_not_idle");
  });

  it("user.interrupt is accepted while running and reaches the runtime", async () => {
    const before = runtime.received.length;
    const accepted = await sendSessionEvent(
      session.id,
      { type: "user.interrupt" },
      writer,
    );
    expect(accepted).toEqual({ accepted: true });
    await until(() => runtime.received.length > before);
    expect(runtime.received.at(-1)?.type).toBe("user.interrupt");
  });

  it("read scope: the event post is denied server-side (403 — §6.4 behind the disabled UI)", async () => {
    const err: unknown = await sendSessionEvent(
      session.id,
      { type: "user.interrupt" },
      reader,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConsoleApiError);
    expect((err as ConsoleApiError).status).toBe(403);
  });
});
