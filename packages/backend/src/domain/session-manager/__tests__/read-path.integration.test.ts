/**
 * R4.4 — the read path never boots a VM.
 *
 * Drives the REAL composition root ({@link createManagedApp}) against a real Postgres
 * (testcontainers/podman) with a **spy SandboxProvider**: a session's events are seeded
 * into the `session_events` projection (R4.1) and NO runtime is ever woken. Then, over
 * HTTP with a real API key:
 *
 * - `GET /v1/sessions/:id/events` returns the FULL history, and the spy records **zero**
 *   `provision` / `start` calls (before R4.4 the route `wake()`d a runtime, which
 *   provisioned a microVM just to read the log).
 * - `GET /v1/sessions/:id/stream` replays that history and ends — no runtime is active, so
 *   no live tail is attached and, again, nothing is provisioned.
 * - An **archived** session's history is still readable, while `POST /events` (advance) is
 *   404 — reading is not advancing.
 *
 * Skips when no container runtime is available.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pino from "pino";
import { FakeSandboxProvider } from "@pi-managed/testkit";
import type { Config } from "../../../infra/config/index.js";
import type { Pool, TenantCtx } from "../../../infra/db/index.js";
import {
  startPostgres,
  hasContainerRuntime,
  type TestDb,
} from "../../../infra/db/__tests__/test-runtime.js";
import { createManagedApp, type ManagedApp } from "../../../app.js";
import { createTenant } from "../../tenant/tenant.js";
import { issueApiKey } from "../../tenant/api-key.js";
import { createAgent } from "../../agent/agent.js";
import { createEnvironment } from "../../environment/environment.js";
import { createSession, deleteSession } from "../../session/index.js";
import { FakeAgentSessionFactory } from "./fake-agent-session.js";

const TEST_KEY = "0".repeat(64);
const silentLogger = pino({ level: "silent" });
const RUNTIME = hasContainerRuntime();

/** The three persisted events of a completed turn (positions 0,1,2). */
const HISTORY = [
  { type: "session.status_run_started", payload: {} },
  { type: "agent.message", payload: { content: "done" } },
  { type: "session.status_idle", payload: { stopReason: "completed" } },
];

function auth(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

/** Parse SSE text into frames: [{id?, event}]. */
function parseFrames(text: string): Array<{ id?: number; event: string }> {
  const frames: Array<{ id?: number; event: string }> = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    let id: number | undefined;
    let event = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("id: ")) id = Number(line.slice(4));
      else if (line.startsWith("event: ")) event = line.slice(7);
    }
    frames.push({ id, event });
  }
  return frames;
}

describe.skipIf(!RUNTIME)("Events read path never provisions a sandbox (R4.4)", () => {
  let db: TestDb;
  let managed: ManagedApp;
  let pool: Pool;
  let ctx: TenantCtx;
  /** The spy: every provision/start lands in `.calls`. It must stay empty. */
  let sandbox: FakeSandboxProvider;
  let apiKey: string;
  let sessionId: string;

  beforeAll(async () => {
    process.env.VAULT_KEY = TEST_KEY;
    db = await startPostgres();
    sandbox = new FakeSandboxProvider();

    managed = await createManagedApp({
      config: {
        port: 3000,
        logLevel: "silent",
        objectStoreRoot: "./data/objectstore",
        sandboxRuntime: "enabled",
        dbUrl: db.connectionString,
      } as Config,
      logger: silentLogger,
      sandboxProvider: sandbox,
      factory: new FakeAgentSessionFactory(),
      objectStoreConfig: undefined,
      revalidationIntervalMs: 0,
    });
    pool = managed.pool;

    const tenant = await createTenant(pool, { name: "Read Path Tenant" });
    ctx = { tenantId: tenant.id };
    apiKey = (await issueApiKey(pool, ctx, { name: "read-path-key" })).key;

    const agent = await createAgent(pool, ctx, {
      name: "read-path-agent",
      model: { provider: "anthropic", id: "claude-sonnet-4-5" },
    });
    const env = await createEnvironment(pool, ctx, {
      name: "read-path-env",
      type: "cloud",
    });
    const session = await createSession(pool, ctx, {
      agent: agent.id,
      environmentId: env.id,
    });
    sessionId = session.id;

    // Seed the projection directly — the session's turn "already happened" on some other
    // node / before a restart. Nothing is in memory: no runtime, no VM.
    for (const [i, e] of HISTORY.entries()) {
      const position = await managed.eventsStore.append(tenant.id, sessionId, {
        type: e.type,
        id: `evt_seed_${i}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        payload: e.payload,
      });
      expect(position).toBe(i);
    }
    // Baseline: creating the session provisioned nothing (sessions are lazily woken).
    expect(sandbox.calls).toHaveLength(0);
  }, 120_000);

  afterAll(async () => {
    await managed?.close();
    await db?.container.stop();
  });

  it("GET /events returns the full history with ZERO provision/start calls", async () => {
    const res = await managed.app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/events?limit=50`,
      headers: auth(apiKey),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ seq: number; type: string }> };
    expect(body.data.map((d) => d.seq)).toEqual([0, 1, 2]);
    expect(body.data.map((d) => d.type)).toEqual(HISTORY.map((e) => e.type));

    // THE assertion: the read woke nothing. No runtime, no microVM.
    expect(sandbox.calls.filter((c) => c.kind === "provision")).toHaveLength(0);
    expect(sandbox.calls.filter((c) => c.kind === "start")).toHaveLength(0);
    expect(sandbox.calls).toHaveLength(0);
    expect(managed.sessionManager.size).toBe(0);
    expect(managed.sessionManager.activeRuntime(sessionId)).toBeUndefined();
  });

  it("GET /stream replays the history of a cold session and provisions nothing", async () => {
    const res = await managed.app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/stream`,
      headers: { ...auth(apiKey), "last-event-id": "0" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const frames = parseFrames(res.body);
    expect(frames.map((f) => f.id)).toEqual([1, 2]);
    expect(frames.map((f) => f.event)).toEqual(["agent.message", "session.status_idle"]);

    expect(sandbox.calls).toHaveLength(0);
    expect(managed.sessionManager.size).toBe(0);
  });

  it("an ARCHIVED session's history stays readable; advancing it is 404", async () => {
    expect(await deleteSession(pool, ctx, sessionId)).toBe(true);

    const read = await managed.app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/events?limit=50`,
      headers: auth(apiKey),
    });
    expect(read.statusCode).toBe(200);
    expect((read.json() as { data: unknown[] }).data).toHaveLength(3);

    const advance = await managed.app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/events`,
      headers: { ...auth(apiKey), "idempotency-key": "rp-1", "content-type": "application/json" },
      payload: JSON.stringify({ type: "user.message", content: "hi" }),
    });
    expect(advance.statusCode).toBe(404);

    expect(sandbox.calls).toHaveLength(0);
  });
});
