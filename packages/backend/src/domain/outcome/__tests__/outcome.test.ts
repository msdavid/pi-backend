/**
 * Outcomes domain tests (WP-3.2, §29.4 gate slice).
 *
 * Covers the done criteria using testkit fakes (FakeGrader / FakeProducer + a fake
 * sandbox provider for the deliverables slice):
 *  - rubric-driven `needs_revision` → `satisfied` loop;
 *  - one-at-a-time (409 if an outcome is active);
 *  - `max_iterations_reached` (one final revision, then idle);
 *  - `failed` (rubric doesn't match);
 *  - `interrupted` (user.interrupt before a grade completes);
 *  - deliverables fetch via the Files-API outputs slice (§16.6).
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
  defineOutcome,
  listOutcomes,
  runOutcomeLoop,
  FakeGrader,
  FakeProducer,
  emitOutcomeEvaluationStart,
  emitOutcomeEvaluationEnd,
  emitOutcomeSessionEnded,
  type OutcomeEventSink,
} from "../index.js";
import {
  listSessionOutputs,
  downloadSessionOutput,
  type SessionSandboxResolver,
} from "../../file/index.js";
import type {
  ExecOptions,
  ExecResult,
  SandboxHandle,
  SandboxProvider,
  SandboxStatus,
} from "../../ports.js";

const RUNTIME = hasContainerRuntime();

const MODEL = { provider: "anthropic", id: "claude-sonnet-4" };

function baseAgentConfig() {
  return {
    name: "outcome-runner",
    model: MODEL,
    systemPrompt: "BASE",
    tools: {
      defaultConfig: { enabled: true, permissionPolicy: "always_allow" as const },
      configs: { bash: { permissionPolicy: "always_ask" as const } },
    },
    skills: [],
    extensions: [],
    mcpServers: [],
    multiagent: { roster: [] },
    metadata: {},
  };
}

/** Collect events for assertion. */
class CollectingEventSink implements OutcomeEventSink {
  readonly events: { type: string; payload: unknown }[] = [];
  emit(event: { type: string; payload: unknown }): void {
    this.events.push({ type: event.type, payload: event.payload });
  }
}

/** A fake sandbox provider that serves a virtual /mnt/session/outputs/ dir. */
class FakeOutputsProvider implements SandboxProvider {
  constructor(private readonly files: Map<string, string>) {}
  async provision(): Promise<SandboxHandle> {
    return { id: "s", name: "s", labels: { tenant: "t", session: "s" } };
  }
  async exec(_handle: SandboxHandle, opts: ExecOptions): Promise<ExecResult> {
    const cmd = typeof opts.cmd === "string" ? opts.cmd : opts.cmd.join(" ");
    const lsMatch = cmd.match(/^ls -1 (.*)$/);
    if (lsMatch) {
      const names = [...this.files.keys()];
      return { stdout: names.join("\n"), stderr: "", exitCode: names.length ? 0 : 1 };
    }
    const catMatch = cmd.match(/^cat (.*)$/);
    if (catMatch) {
      const path = catMatch[1];
      const name = path.split("/").pop()!;
      const content = this.files.get(name);
      if (content === undefined) return { stdout: "", stderr: "no file", exitCode: 1 };
      return { stdout: content, stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }
  async *execStream() {}
  async stop() {}
  async start() {}
  async snapshot() {
    return "snap";
  }
  async destroy() {}
  async reattachByLabels() {
    return [];
  }
  async status(): Promise<SandboxStatus> {
    return "running";
  }
  async registerSecretBinding() {}
}

describe.skipIf(!RUNTIME)("outcomes domain (WP-3.2, §16)", () => {
  let db: TestDb;
  let pool: Pool;
  let ctx: TenantCtx;
  let agentId: string;
  let envId: string;

  async function makeSession(): Promise<string> {
    const s = await createSession(pool, ctx, {
      agent: agentId,
      environmentId: envId,
      title: "outcome-session",
    });
    return s.id;
  }

  async function runLoop(
    sessionId: string,
    outcomeId: string,
    opts: {
      maxIterations: number;
      grader: FakeGrader;
      producer: FakeProducer;
    },
  ): Promise<{ result: string; events: CollectingEventSink }> {
    const events = new CollectingEventSink();
    const result = await runOutcomeLoop({
      pool,
      tenantCtx: ctx,
      sessionId,
      outcomeId,
      maxIterations: opts.maxIterations,
      description: "Refactor auth.ts to use async/await",
      rubricText: "## Criteria\n- All callbacks converted to async/await",
      producer: opts.producer,
      grader: opts.grader,
      events,
    });
    return { result, events };
  }

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
    const t = await createTenant(pool, { name: "Outcome Tenant" });
    ctx = { tenantId: t.id };
    const agent = await createAgent(pool, ctx, baseAgentConfig());
    agentId = agent.id;
    const env = await createEnvironment(pool, ctx, {
      name: "py-env",
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

  // --- one-at-a-time (409) -------------------------------------------------
  it("rejects a second active outcome with 409 (§16.5)", async () => {
    const sessionId = await makeSession();
    const first = await defineOutcome(pool, ctx, sessionId, {
      description: "do A",
      rubric: { type: "text", content: "criteria A" },
      maxIterations: 3,
    });
    expect(first.status).toBe("active");
    expect(first.iteration).toBe(0);
    expect(first.id).toMatch(/^outc_/);

    await expect(
      defineOutcome(pool, ctx, sessionId, {
        description: "do B",
        rubric: { type: "text", content: "criteria B" },
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "conflict" });
  });

  it("applies maxIterations default (3) and rejects > 20", async () => {
    const sessionId = await makeSession();
    const o = await defineOutcome(pool, ctx, sessionId, {
      description: "default iters",
      rubric: { type: "text", content: "c" },
    });
    expect(o.id).toMatch(/^outc_/);
    // max > 20 is rejected by the contracts schema (422).
    await expect(
      defineOutcome(pool, ctx, sessionId, {
        description: "too many",
        rubric: { type: "text", content: "c" },
        maxIterations: 21,
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  // --- needs_revision → satisfied loop (§29.4 gate slice) ------------------
  it("iterates needs_revision → satisfied and emits the terminal event", async () => {
    const sessionId = await makeSession();
    const outcome = await defineOutcome(pool, ctx, sessionId, {
      description: "refactor",
      rubric: { type: "text", content: "criteria" },
      maxIterations: 3,
    });
    const grader = new FakeGrader();
    grader.script(
      {
        verdict: "needs_revision",
        criteria: [{ criterion: "async-await", passed: false }],
        feedback: "convert the login callback",
      },
      {
        verdict: "satisfied",
        criteria: [{ criterion: "async-await", passed: true }],
        feedback: "",
      },
    );
    const producer = new FakeProducer();
    const { result, events } = await runLoop(sessionId, outcome.id, {
      maxIterations: 3,
      grader,
      producer,
    });

    expect(result).toBe("satisfied");
    // Two grades: first needs_revision, second satisfied.
    expect(grader.invocationCount).toBe(2);
    // Two produces for the two passes (no final revision on satisfied).
    expect(producer.calls).toHaveLength(2);
    // Feedback handed back after the first grade.
    expect(producer.calls[1]).toBe("convert the login callback");
    // Events: start/end per pass (×2) + one terminal session event.
    const types = events.events.map((e) => e.type);
    expect(types.filter((t) => t === "span.outcome_evaluation_start")).toHaveLength(2);
    expect(types.filter((t) => t === "span.outcome_evaluation_end")).toHaveLength(2);
    expect(types).toContain("session.outcome_evaluation_ended");
    const ended = events.events.find((e) => e.type === "session.outcome_evaluation_ended");
    expect((ended!.payload as { result: string }).result).toBe("satisfied");

    // Persisted: terminal satisfied, iteration = 2.
    const listed = await listOutcomes(pool, ctx, sessionId, { limit: 50 });
    expect(listed.data[0].result).toBe("satisfied");
    expect(listed.data[0].status).toBe("satisfied");
    expect(listed.data[0].iteration).toBe(2);

    // Chainable: a new outcome can be defined now that this one is terminal.
    await expect(
      defineOutcome(pool, ctx, sessionId, {
        description: "next",
        rubric: { type: "text", content: "c2" },
      }),
    ).resolves.toMatchObject({ status: "active" });
  });

  // --- max_iterations_reached (one final revision, then idle) --------------
  it("reaches max_iterations_reached after exhausting iterations (§16.5)", async () => {
    const sessionId = await makeSession();
    const outcome = await defineOutcome(pool, ctx, sessionId, {
      description: "refactor",
      rubric: { type: "text", content: "criteria" },
      maxIterations: 2,
    });
    const grader = new FakeGrader();
    grader.script(
      {
        verdict: "needs_revision",
        criteria: [{ criterion: "c", passed: false }],
        feedback: "fix 1",
      },
      {
        verdict: "needs_revision",
        criteria: [{ criterion: "c", passed: false }],
        feedback: "fix 2",
      },
    );
    const producer = new FakeProducer();
    const { result } = await runLoop(sessionId, outcome.id, {
      maxIterations: 2,
      grader,
      producer,
    });

    expect(result).toBe("max_iterations_reached");
    // 2 grades (both needs_revision) + 1 final revision produce = 3 produces.
    expect(grader.invocationCount).toBe(2);
    expect(producer.calls).toHaveLength(3);
    // The final produce carries the last feedback.
    expect(producer.calls[2]).toBe("fix 2");

    const listed = await listOutcomes(pool, ctx, sessionId, { limit: 50 });
    expect(listed.data[0].result).toBe("max_iterations_reached");
    expect(listed.data[0].status).toBe("max_iterations_reached");
    expect(listed.data[0].iteration).toBe(2);
  });

  // --- failed (rubric doesn't match) → idle --------------------------------
  it("ends as failed when the grader reports a fatal mismatch (§16.5)", async () => {
    const sessionId = await makeSession();
    const outcome = await defineOutcome(pool, ctx, sessionId, {
      description: "refactor",
      rubric: { type: "text", content: "criteria" },
      maxIterations: 3,
    });
    const grader = new FakeGrader();
    grader.script({
      verdict: "needs_revision",
      criteria: [],
      feedback: "",
      failed: { reason: "deliverables do not match the rubric at all" },
    });
    const producer = new FakeProducer();
    const { result } = await runLoop(sessionId, outcome.id, {
      maxIterations: 3,
      grader,
      producer,
    });

    expect(result).toBe("failed");
    expect(grader.invocationCount).toBe(1);
    expect(producer.calls).toHaveLength(1);

    const listed = await listOutcomes(pool, ctx, sessionId, { limit: 50 });
    expect(listed.data[0].result).toBe("failed");
    expect(listed.data[0].status).toBe("failed");
  });

  // --- interrupted (user.interrupt before a grade completes) ---------------
  it("ends as interrupted when a user.interrupt arrives before grading (§16.5)", async () => {
    const sessionId = await makeSession();
    const outcome = await defineOutcome(pool, ctx, sessionId, {
      description: "refactor",
      rubric: { type: "text", content: "criteria" },
      maxIterations: 3,
    });
    const grader = new FakeGrader();
    const producer = new FakeProducer();
    // Simulate an interrupt landing during the first produce.
    producer.onProduce = () => producer.interrupt();
    const { result } = await runLoop(sessionId, outcome.id, {
      maxIterations: 3,
      grader,
      producer,
    });

    expect(result).toBe("interrupted");
    // The grade never ran (interrupted before evaluation).
    expect(grader.invocationCount).toBe(0);
    const listed = await listOutcomes(pool, ctx, sessionId, { limit: 50 });
    expect(listed.data[0].result).toBe("interrupted");
    expect(listed.data[0].status).toBe("interrupted");
  });

  // --- deliverables fetch via the Files-API outputs slice (§16.6) ----------
  it("lists + downloads deliverables from an idle session's outputs (§16.6)", async () => {
    const sessionId = await makeSession();
    // The session is idle by default (createSession → status "idle").
    const files = new Map<string, string>([
      ["report.md", "# Refactor report\nAll callbacks converted."],
      ["diff.patch", "--- a/auth.ts\n+++ b/auth.ts\n"],
    ]);
    const provider = new FakeOutputsProvider(files);
    const resolver: SessionSandboxResolver = {
      resolve: async () => ({
        id: "s",
        name: "s",
        labels: { tenant: "t", session: sessionId },
      }),
    };

    const listed = await listSessionOutputs(pool, ctx, provider, resolver, sessionId);
    expect(listed.data.map((f) => f.name).sort()).toEqual(["diff.patch", "report.md"]);

    const dl = await downloadSessionOutput(
      pool,
      ctx,
      provider,
      resolver,
      sessionId,
      "report.md",
    );
    const text = await new Response(dl.stream).text();
    expect(text).toContain("All callbacks converted");
  });

  // --- event helpers format correctly --------------------------------------
  it("event helpers emit the documented types + payloads", () => {
    const sink = new CollectingEventSink();
    emitOutcomeEvaluationStart(sink, { sessionId: "s1", outcomeId: "o1" }, 0);
    emitOutcomeEvaluationEnd(
      sink,
      { sessionId: "s1", outcomeId: "o1" },
      0,
      "needs_revision",
      [{ criterion: "c", passed: false }],
      "fix it",
    );
    emitOutcomeSessionEnded(sink, { sessionId: "s1", outcomeId: "o1" }, "satisfied", 2);
    const types = sink.events.map((e) => e.type);
    expect(types).toEqual([
      "span.outcome_evaluation_start",
      "span.outcome_evaluation_end",
      "session.outcome_evaluation_ended",
    ]);
    const ended = sink.events[2].payload as { result: string; iteration: number };
    expect(ended.result).toBe("satisfied");
    expect(ended.iteration).toBe(2);
  });
});
