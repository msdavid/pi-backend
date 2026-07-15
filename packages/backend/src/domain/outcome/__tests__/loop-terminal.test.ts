/**
 * Outcome loop terminality tests (R6.3).
 *
 * Before R6.3 an outcome row that was never driven — or whose loop hung / crashed — stayed
 * `active` forever, and an `active` row 409-blocks EVERY future outcome on that session
 * (§16.5 one-at-a-time). These tests pin the four exits that must land terminal:
 *
 *  - a hung producer trips the wall-clock timeout → `failed`;
 *  - an explicit cancel (`cancelOutcome` / the cancel route) → `interrupted`;
 *  - a crashing grader → `failed` (the error still propagates to the caller);
 *  - a grade in flight is CANCELLABLE — an interrupt during the grade ends the loop
 *    `interrupted` instead of waiting for the grader to return.
 *
 * Plus the happy path through the real loop (produce → grade → feedback → satisfied) and
 * `max_iterations_reached`, asserted on the persisted row (a terminal status frees the
 * session's slot: a new outcome can be defined).
 *
 * Uses testcontainers-postgres (real migrations). Skips without a container runtime.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPool,
  closePool,
  runMigrations,
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
import {
  cancelOutcome,
  defineOutcome,
  expireStaleOutcomes,
  fetchOutcomeRow,
  runOutcomeLoop,
  FakeGrader,
  FakeProducer,
  type Grader,
  type GradeInput,
  type GraderEvaluation,
  type OutcomeEventSink,
  type OutcomeProducer,
} from "../index.js";
import type { OutboundEvent } from "../../ports.js";

const RUNTIME = hasContainerRuntime();

class Sink implements OutcomeEventSink {
  readonly events: OutboundEvent[] = [];
  emit(event: OutboundEvent): void {
    this.events.push(event);
  }
}

/** A producer whose `produce` never settles (a session that never comes back). */
class HangingProducer implements OutcomeProducer {
  produce(): Promise<void> {
    return new Promise<void>(() => {});
  }
  wasInterrupted(): boolean {
    return false;
  }
}

/** A producer that exposes an interrupt signal the test controls. */
class SignallingProducer implements OutcomeProducer {
  readonly controller = new AbortController();
  private interrupted = false;
  async produce(): Promise<void> {}
  wasInterrupted(): boolean {
    return this.interrupted;
  }
  interruptSignal(): AbortSignal {
    return this.controller.signal;
  }
  /** Simulate a `user.interrupt` landing on the session stream. */
  interrupt(): void {
    this.interrupted = true;
    this.controller.abort();
  }
}

/** A grader that never returns until its `signal` aborts (a grade in flight). */
class HangingGrader implements Grader {
  started = false;
  aborted = false;
  evaluate(input: GradeInput): Promise<GraderEvaluation> {
    this.started = true;
    return new Promise<GraderEvaluation>((_resolve, reject) => {
      input.signal?.addEventListener("abort", () => {
        this.aborted = true;
        reject(new Error("grade aborted"));
      });
    });
  }
}

/** A grader that throws (a crashed loop). */
class ThrowingGrader implements Grader {
  evaluate(): Promise<GraderEvaluation> {
    return Promise.reject(new Error("grader exploded"));
  }
}

describe.skipIf(!RUNTIME)("outcome loop terminality (R6.3)", () => {
  let db: TestDb;
  let pool: Pool;
  let ctx: TenantCtx;
  let agentId: string;
  let envId: string;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
    const t = await createTenant(pool, { name: "R6.3 Tenant" });
    ctx = { tenantId: t.id };
    const agent = await createAgent(pool, ctx, {
      name: "outcome-agent",
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
    });
    agentId = agent.id;
    const env = await createEnvironment(pool, ctx, {
      name: "env",
      type: "cloud",
      resources: { cpus: 1, memoryMiB: 1024 },
      networking: { mode: "unrestricted" },
    });
    envId = env.id;
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  }, 120_000);

  async function newOutcome(maxIterations = 3): Promise<{ sessionId: string; outcomeId: string }> {
    const s = await createSession(pool, ctx, { agent: agentId, environmentId: envId });
    const o = await defineOutcome(pool, ctx, s.id, {
      description: "Write a hello file",
      rubric: { type: "text", content: "A greeting file exists." },
      maxIterations,
    });
    return { sessionId: s.id, outcomeId: o.id };
  }

  function loop(
    sessionId: string,
    outcomeId: string,
    over: Partial<Parameters<typeof runOutcomeLoop>[0]>,
  ): Promise<string> {
    return runOutcomeLoop({
      pool,
      tenantCtx: ctx,
      sessionId,
      outcomeId,
      maxIterations: 3,
      description: "Write a hello file",
      rubricText: "A greeting file exists.",
      producer: new FakeProducer(),
      grader: new FakeGrader(),
      events: new Sink(),
      ...over,
    } as Parameters<typeof runOutcomeLoop>[0]);
  }

  async function status(outcomeId: string): Promise<{ status: string; result: string | null }> {
    const row = await fetchOutcomeRow(pool, ctx, outcomeId);
    return { status: row!.status, result: row!.result };
  }

  // --- happy path through the real loop ------------------------------------
  it("produce → grade → feedback → satisfied, and frees the session slot", async () => {
    const { sessionId, outcomeId } = await newOutcome(3);
    const grader = new FakeGrader();
    grader.script(
      { verdict: "needs_revision", criteria: [], feedback: "add the greeting" },
      { verdict: "satisfied", criteria: [{ criterion: "greets", passed: true }], feedback: "" },
    );
    const producer = new FakeProducer();

    const result = await loop(sessionId, outcomeId, { grader, producer });

    expect(result).toBe("satisfied");
    expect(producer.calls).toEqual([undefined, "add the greeting"]);
    expect(await status(outcomeId)).toEqual({ status: "satisfied", result: "satisfied" });
    // Terminal ⇒ chainable (no 409).
    await expect(
      defineOutcome(pool, ctx, sessionId, {
        description: "next",
        rubric: { type: "text", content: "c" },
      }),
    ).resolves.toMatchObject({ status: "active" });
  }, 30_000);

  it("lands max_iterations_reached (terminal) after exhausting iterations", async () => {
    const { sessionId, outcomeId } = await newOutcome(2);
    const grader = new FakeGrader();
    grader.script(
      { verdict: "needs_revision", criteria: [], feedback: "fix 1" },
      { verdict: "needs_revision", criteria: [], feedback: "fix 2" },
    );
    const producer = new FakeProducer();

    const result = await loop(sessionId, outcomeId, { grader, producer, maxIterations: 2 });

    expect(result).toBe("max_iterations_reached");
    // One final revision after the last grade (§16.5).
    expect(producer.calls).toEqual([undefined, "fix 1", "fix 2"]);
    expect(await status(outcomeId)).toEqual({
      status: "max_iterations_reached",
      result: "max_iterations_reached",
    });
  }, 30_000);

  // --- a stuck loop must not stay `active` forever --------------------------
  it("times out a hung loop into a terminal failed (never stuck on active)", async () => {
    const { sessionId, outcomeId } = await newOutcome();

    const result = await loop(sessionId, outcomeId, {
      producer: new HangingProducer(),
      timeoutMs: 50,
    });

    expect(result).toBe("failed");
    expect(await status(outcomeId)).toEqual({ status: "failed", result: "failed" });
    // The session is usable again — a stuck outcome no longer 409-blocks it.
    await expect(
      defineOutcome(pool, ctx, sessionId, {
        description: "after the timeout",
        rubric: { type: "text", content: "c" },
      }),
    ).resolves.toMatchObject({ status: "active" });
  }, 30_000);

  it("cancels a running loop into a terminal interrupted", async () => {
    const { sessionId, outcomeId } = await newOutcome();
    const controller = new AbortController();

    const running = loop(sessionId, outcomeId, {
      producer: new HangingProducer(),
      signal: controller.signal,
      timeoutMs: 0, // no timeout — only the explicit cancel can end this
    });
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();

    expect(await running).toBe("interrupted");
    expect(await status(outcomeId)).toEqual({ status: "interrupted", result: "interrupted" });
  }, 30_000);

  it("cancels a grade already in flight (not just between produce and grade)", async () => {
    const { sessionId, outcomeId } = await newOutcome();
    const producer = new SignallingProducer();
    const grader = new HangingGrader();

    const running = loop(sessionId, outcomeId, { producer, grader, timeoutMs: 0 });
    // Wait until the grade has started, then interrupt mid-grade.
    while (!grader.started) await new Promise((r) => setTimeout(r, 2));
    producer.interrupt();

    expect(await running).toBe("interrupted");
    expect(grader.aborted).toBe(true); // the grade was cancelled, not awaited
    expect(await status(outcomeId)).toEqual({ status: "interrupted", result: "interrupted" });
  }, 30_000);

  it("records a terminal failed when the loop crashes", async () => {
    const { sessionId, outcomeId } = await newOutcome();

    await expect(
      loop(sessionId, outcomeId, { grader: new ThrowingGrader() }),
    ).rejects.toThrow(/exploded/);

    expect(await status(outcomeId)).toEqual({ status: "failed", result: "failed" });
  }, 30_000);

  // --- the never-driven row (no runner wired / process died) ----------------
  it("expires a stale never-driven outcome so it stops 409-blocking the session", async () => {
    const { sessionId, outcomeId } = await newOutcome();
    // Nothing ever drove this outcome — it is `active` and blocks the session.
    await expect(
      defineOutcome(pool, ctx, sessionId, {
        description: "blocked",
        rubric: { type: "text", content: "c" },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    // Past the deadline it is reaped (defineOutcome runs the same sweep with the
    // configured timeout; here we force a 10ms cap so the row is already "stale").
    await new Promise((r) => setTimeout(r, 30));
    const expired = await expireStaleOutcomes(pool, ctx, sessionId, 10);
    expect(expired).toBe(1);
    expect(await status(outcomeId)).toEqual({ status: "failed", result: "failed" });

    await expect(
      defineOutcome(pool, ctx, sessionId, {
        description: "unblocked",
        rubric: { type: "text", content: "c" },
      }),
    ).resolves.toMatchObject({ status: "active" });
  }, 30_000);

  it("cancelOutcome finalizes a non-terminal outcome and is idempotent", async () => {
    const { sessionId, outcomeId } = await newOutcome();

    const cancelled = await cancelOutcome(pool, ctx, sessionId, outcomeId);
    expect(cancelled.status).toBe("interrupted");
    expect(cancelled.result).toBe("interrupted");

    // Idempotent: a second cancel returns the same terminal row.
    const again = await cancelOutcome(pool, ctx, sessionId, outcomeId);
    expect(again.status).toBe("interrupted");

    await expect(
      cancelOutcome(pool, ctx, sessionId, "outc_missing"),
    ).rejects.toMatchObject({ statusCode: 404 });
  }, 30_000);
});
