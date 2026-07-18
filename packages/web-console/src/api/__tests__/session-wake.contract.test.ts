// @vitest-environment node
/**
 * Wake-on-message contract tests (WP-C4.2; console-spec §10.1, journey W5
 * "the session cold-wakes and the reply streams in"): the Conversation
 * composer's send path against the REAL backend over real HTTP — real
 * Postgres (testcontainer), real Fastify app, the real global `fetch`, a
 * real cookie console session with the real CSRF header (CONVENTIONS.md
 * "Fakes at the seam").
 *
 * **What the wake contract IS on the wire** (`api/events.ts`): a
 * `user.message` POSTed to an IDLE session passes the ROB-5 guard and makes
 * the route call `resolveRuntime(sessionId)` — the documented ADVANCE seam
 * that, in production, is `sessionManager.getOrCreate` → `wake()` →
 * sandbox (re-)provision. The route answers `202 {accepted: true}` before
 * any turn output exists; the session's reaction (status flip, new frames)
 * arrives on the §8 stream. That is exactly the composer's rendering model
 * (accepted ≠ replied — the waking note holds until `status_run_started`).
 *
 * **What is (deliberately) not exercised here:** the sandbox provisioning
 * and model turn INSIDE the production `resolveRuntime` — a real cold wake
 * runs `SessionManager.wake()` against a Microsandbox/KVM host and then
 * spends a model-provider key on a live agent turn, neither of which the
 * harness has (no sandbox host is configured and no provider credential
 * exists in the test tenant's vaults). A scripted runtime COLLABORATOR
 * (`./collaborators.ts`) stands behind the same documented
 * `CreateAppOptions` seams instead and mirrors the manager's wake reaction
 * — persist the message, flip the row to `running`, emit
 * `session.status_run_started` — so this suite proves everything the
 * console can observe of a wake: the resolver invocation, the 202, and the
 * transition frames on the open stream. The end-to-end wake with a real VM
 * is scripted in the `@kvm` phase-4 gate (WP-C4.3,
 * `test/phase4-gate/continue-anywhere.gate.test.ts`).
 *
 * Covers:
 *  - W5 step 2 wire: seeded idle session → `user.message` through the
 *    composer's client path (cookie + CSRF + auto Idempotency-Key) → 202,
 *    the ADVANCE resolver invoked (the wake seam), the runtime handed the
 *    message, and the `session.status_run_started` transition observed on
 *    the already-open stream with the detail read agreeing;
 *  - the §10.2 queue-flush wire: the turn ends (row back to `idle`), the
 *    held follow-up posts and is accepted — one message per turn boundary,
 *    exactly what the composer's client-side queue does (its mid-turn 409
 *    counterpart is covered in `session-events.contract.test.ts`).
 *
 * Run with `PI_REQUIRE_INTEGRATION=containers` so a missing container
 * runtime fails instead of silently skipping.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Session } from "@pi-managed/contracts";
import { tenantScopedQuery } from "@pi-managed/backend";

import { ConsoleApiClient } from "../client.js";
import { sendSessionEvent } from "../session-events.js";
import { getSession } from "../sessions.js";
import { streamSessionEvents, type SseFrame } from "../stream.js";
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

const RUNTIME = requireContainers("web-console session-wake contract suite");

describe.skipIf(!RUNTIME)("composer wake ↔ real backend (W5)", () => {
  let backend: TestBackend;
  /** Cookie client for the writing user (the composer's client). */
  let writer: ConsoleApiClient;
  const projection = new InMemoryProjection();
  const runtime = new ConfirmingRuntime();
  /** Session ids the ADVANCE path resolved a runtime for (the wake seam). */
  const resolved: string[] = [];
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

  /** Flip the session row's status/stop_reason (the manager's writes). */
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
        resolveRuntime: async (sessionId) => {
          resolved.push(sessionId);
          return runtime;
        },
        getActiveRuntime: (sessionId) =>
          session && sessionId === session.id ? runtime : undefined,
        sessionEvents: projection.reader,
      },
    });
    const admin = new ConsoleApiClient({
      baseUrl: backend.baseUrl,
      headers: { Authorization: `Bearer ${backend.adminKey}` },
    });
    session = await seedSession(admin, "wake-flow");
    writer = new ConsoleApiClient({
      baseUrl: backend.baseUrl,
      headers: { Cookie: await signInCookie(backend.baseUrl, backend.adminKey) },
    });

    // The manager's scripted wake reaction (§10.1): persist the message,
    // return the session to running, emit the status transition.
    runtime.onEvent = async (event) => {
      if (event.type !== "user.message") return;
      emit(session.id, event.type, event.payload);
      await setSessionState("running", null);
      emit(session.id, "session.status_run_started", {});
    };
  }, 180_000);

  afterAll(async () => {
    if (backend) await backend.stop();
  }, 120_000);

  it(
    "W5 step 2: user.message to an idle session is accepted, resolves the wake seam, and the transition streams",
    { timeout: 30_000 },
    async () => {
      // Precondition: a freshly created session is idle — the wake case.
      expect(session.status).toBe("idle");

      // Watch the session like the console does (§8 stream, cookie auth).
      const frames: SseFrame[] = [];
      const controller = new AbortController();
      const done = streamSessionEvents(
        session.id,
        { onFrame: (f) => frames.push(f) },
        {
          signal: controller.signal,
          baseUrl: backend.baseUrl,
          headers: {
            Cookie: await signInCookie(backend.baseUrl, backend.readKey),
          },
        },
      );

      // The composer's Send: cookie + CSRF + auto Idempotency-Key.
      const accepted = await sendSessionEvent(
        session.id,
        { type: "user.message", content: "pick up where we left off" },
        writer,
      );
      // 202 is acceptance, not a reply — the composer renders a waking note
      // until the status frame lands.
      expect(accepted).toEqual({ accepted: true });

      // The ADVANCE resolver ran for this session: in production this call
      // IS the cold wake (sessionManager.getOrCreate → wake() → provision).
      expect(resolved).toContain(session.id);
      await until(() => runtime.received.some((e) => e.type === "user.message"));

      // The wake is observable exactly as the composer renders it: the
      // message + session.status_run_started arrive on the open stream…
      await until(() => frames.length >= 2);
      controller.abort();
      await done;
      expect(frames.map((f) => f.event)).toEqual([
        "user.message",
        "session.status_run_started",
      ]);
      expect(frames.map((f) => f.id)).toEqual([0, 1]);

      // …and the detail read agrees (the stream invalidation's refetch).
      const after = await getSession(session.id, writer);
      expect(after.status).toBe("running");
    },
  );

  it(
    "§10.2 queue flush: the held follow-up is accepted at the next turn boundary",
    { timeout: 30_000 },
    async () => {
      // The turn the previous test started completes.
      await setSessionState("idle", "completed");
      emit(session.id, "session.status_idle", { stopReason: "completed" });

      // What the composer's flush effect posts at the observed idle.
      const accepted = await sendSessionEvent(
        session.id,
        { type: "user.message", content: "also update the changelog" },
        writer,
      );
      expect(accepted).toEqual({ accepted: true });
      await until(
        () =>
          runtime.received.filter((e) => e.type === "user.message").length >= 2,
      );
      const after = await getSession(session.id, writer);
      expect(after.status).toBe("running");
    },
  );
});
