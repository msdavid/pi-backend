/**
 * SessionEventsStore tests (R4.1 — real Postgres).
 *
 * The append-only event projection (§9.1/§9.3): every outbound event is persisted with a
 * per-session 0-based monotonic `position` that equals the SSE `id`. Verifies:
 *  - append assigns positions 0,1,2 and read() returns them with the right type/payload;
 *  - ranged read (start/end/limit) slices by position;
 *  - append is idempotent on the event id (a re-append returns the existing position and
 *    does not duplicate);
 *  - many parallel appends to one session all land with contiguous positions and none throw
 *    (ROB-21 — the per-session advisory lock serializes position allocation);
 *  - retention (deleteOlderThan / pruneSession) bounds the projection's growth (PERF-9).
 *
 * Uses testcontainers-postgres (real migrations, incl. 030 session_events). Skips without
 * a container runtime.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPool,
  closePool,
  type Pool,
  type TenantCtx,
} from "../../../infra/db/index.js";
import {
  startPostgres,
  hasContainerRuntime,
  type TestDb,
} from "../../../infra/db/__tests__/test-runtime.js";
import { createTenant } from "../../tenant/tenant.js";
import { createAgent } from "../../agent/agent.js";
import { createEnvironment } from "../../environment/environment.js";
import { createSession } from "../../session/index.js";
import { SessionEventsStore, type SessionEventInput } from "../session-events-store.js";

const RUNTIME = hasContainerRuntime();

function baseAgentConfig() {
  return {
    name: "events-runner",
    model: { provider: "anthropic", id: "claude-sonnet-4" },
    systemPrompt: "BASE",
    tools: {
      defaultConfig: { enabled: true, permissionPolicy: "always_allow" as const },
      configs: {},
    },
    skills: [],
    extensions: [],
    mcpServers: [],
    multiagent: { roster: [] },
    metadata: {},
  };
}

/** Build an outbound-event input with a stable id. */
function ev(type: string, payload: unknown, id = `evt_${type}`): SessionEventInput {
  return { type, id, createdAt: new Date().toISOString(), payload };
}

describe.skipIf(!RUNTIME)("SessionEventsStore (R4.1)", () => {
  let db: TestDb;
  let pool: Pool;
  let ctx: TenantCtx;
  let agentId: string;
  let envId: string;
  let store: SessionEventsStore;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    const { runMigrations } = await import("../../../infra/db/index.js");
    await runMigrations(db.connectionString, "up");
    const t = await createTenant(pool, { name: "Events Tenant" });
    ctx = { tenantId: t.id };
    const agent = await createAgent(pool, ctx, baseAgentConfig());
    agentId = agent.id;
    const env = await createEnvironment(pool, ctx, {
      name: "events-env",
      type: "cloud",
      resources: { cpus: 1, memoryMiB: 1024 },
      networking: { mode: "unrestricted" },
    });
    envId = env.id;
    store = new SessionEventsStore(pool);
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  }, 120_000);

  async function newSession(): Promise<string> {
    const s = await createSession(pool, ctx, { agent: agentId, environmentId: envId });
    return s.id;
  }

  it("append assigns positions 0,1,2 and read() returns them with type/payload", async () => {
    const sid = await newSession();

    const p0 = await store.append(ctx.tenantId, sid, ev("session.status_run_started", { a: 1 }));
    const p1 = await store.append(ctx.tenantId, sid, ev("agent.message", { content: "hi" }));
    const p2 = await store.append(ctx.tenantId, sid, ev("session.status_idle", { stopReason: "completed" }));
    expect([p0, p1, p2]).toEqual([0, 1, 2]);

    const entries = await store.read(sid);
    expect(entries.map((e) => e.position)).toEqual([0, 1, 2]);
    expect(entries.map((e) => e.type)).toEqual([
      "session.status_run_started",
      "agent.message",
      "session.status_idle",
    ]);
    expect(entries[1].payload).toEqual({ content: "hi" });
    expect(entries[1].id).toBe("evt_agent.message");

    expect(await store.count(sid)).toBe(3);
    expect(await store.head(sid)).toBe(3);
  });

  it("ranged read slices by position (start inclusive, end exclusive, limit)", async () => {
    const sid = await newSession();
    for (let i = 0; i < 5; i++) {
      await store.append(ctx.tenantId, sid, ev(`t${i}`, { i }, `evt_${i}`));
    }

    // start inclusive
    expect((await store.read(sid, { start: 2 })).map((e) => e.position)).toEqual([2, 3, 4]);
    // end exclusive
    expect((await store.read(sid, { start: 1, end: 3 })).map((e) => e.position)).toEqual([1, 2]);
    // limit
    expect((await store.read(sid, { limit: 2 })).map((e) => e.position)).toEqual([0, 1]);
    // start + limit
    expect((await store.read(sid, { start: 3, limit: 5 })).map((e) => e.position)).toEqual([3, 4]);
  });

  it("append is idempotent on the event id (same position, no duplicate)", async () => {
    const sid = await newSession();
    const first = await store.append(ctx.tenantId, sid, ev("agent.message", { n: 1 }, "evt_dup"));
    const again = await store.append(ctx.tenantId, sid, ev("agent.message", { n: 1 }, "evt_dup"));
    expect(again).toBe(first);
    expect(await store.count(sid)).toBe(1);

    // A different event still advances to the next position.
    const next = await store.append(ctx.tenantId, sid, ev("session.status_idle", {}, "evt_other"));
    expect(next).toBe(first + 1);
    expect(await store.count(sid)).toBe(2);
  });

  it("reads are scoped per session (no cross-session bleed)", async () => {
    const a = await newSession();
    const b = await newSession();
    await store.append(ctx.tenantId, a, ev("agent.message", { s: "a" }, "evt_a"));
    expect(await store.count(a)).toBe(1);
    expect(await store.count(b)).toBe(0);
    expect(await store.head(b)).toBe(0);
  });

  it("many parallel appends to one session all land with contiguous positions (ROB-21)", async () => {
    const sid = await newSession();
    const N = 64;

    // Fire all appends concurrently: without the per-session advisory lock these race for
    // MAX(position)+1 and either livelock or throw after exhausting retries. Each must
    // resolve (none rejects) and the returned positions must be exactly 0..N-1.
    const positions = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.append(ctx.tenantId, sid, ev(`agent.message`, { i }, `evt_${i}`)),
      ),
    );

    expect([...positions].sort((x, y) => x - y)).toEqual(
      Array.from({ length: N }, (_, i) => i),
    );
    // And the persisted projection is a gap-free 0..N-1 run.
    const entries = await store.read(sid);
    expect(entries.map((e) => e.position)).toEqual(
      Array.from({ length: N }, (_, i) => i),
    );
    expect(await store.count(sid)).toBe(N);
  });

  it("concurrent re-append of the same event id is idempotent under the lock", async () => {
    const sid = await newSession();
    // The same event id appended many times in parallel must resolve to a single position.
    const results = await Promise.all(
      Array.from({ length: 16 }, () =>
        store.append(ctx.tenantId, sid, ev("agent.message", { n: 1 }, "evt_race_dup")),
      ),
    );
    expect(new Set(results).size).toBe(1);
    expect(await store.count(sid)).toBe(1);
  });

  it("deleteOlderThan prunes events emitted before the cutoff (PERF-9)", async () => {
    const sid = await newSession();
    const old = "2020-01-01T00:00:00.000Z";
    const recent = "2020-06-01T00:00:00.000Z";
    // created_at is sourced from the event's createdAt (see the store's insert).
    await store.append(ctx.tenantId, sid, { type: "agent.message", id: "evt_old_0", createdAt: old, payload: {} });
    await store.append(ctx.tenantId, sid, { type: "agent.message", id: "evt_old_1", createdAt: old, payload: {} });
    await store.append(ctx.tenantId, sid, { type: "agent.message", id: "evt_new_0", createdAt: recent, payload: {} });
    expect(await store.count(sid)).toBe(3);

    const deleted = await store.deleteOlderThan(new Date("2020-03-01T00:00:00.000Z"));
    expect(deleted).toBe(2);
    const remaining = await store.read(sid);
    expect(remaining.map((e) => e.id)).toEqual(["evt_new_0"]);
  });

  it("pruneSession deletes the whole projection for one session only (PERF-9)", async () => {
    const a = await newSession();
    const b = await newSession();
    await store.append(ctx.tenantId, a, ev("agent.message", {}, "evt_pa_0"));
    await store.append(ctx.tenantId, a, ev("agent.message", {}, "evt_pa_1"));
    await store.append(ctx.tenantId, b, ev("agent.message", {}, "evt_pb_0"));

    const deleted = await store.pruneSession(a);
    expect(deleted).toBe(2);
    expect(await store.count(a)).toBe(0);
    expect(await store.count(b)).toBe(1);
  });
});
