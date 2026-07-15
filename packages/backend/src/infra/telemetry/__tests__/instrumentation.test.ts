/**
 * Telemetry EMISSION tests (WP-8.1).
 *
 * These assert that the production code paths actually export spans and metrics —
 * not that the name constants exist. A `NodeSDK` (the same class `initTelemetry`
 * starts in production) is booted with an {@link InMemorySpanExporter} and an
 * in-memory metric reader, registering the global tracer + meter providers. Every
 * subject below is the REAL implementation:
 *
 * - `ManagedSessionRuntime` driven through `wake()` + a scripted `user.message`
 *   turn → `pi.session.wake`, `pi.session.turn`, `pi.model.request`, `pi.tool.<name>`.
 * - `MicrosandboxProvider` with the `microsandbox` NAPI SDK mocked (the msb runtime
 *   needs `/dev/kvm`; the provider's own code is untouched) → `pi.sandbox.*`.
 * - `PgUsageRecorder.record()` over a fake pg pool → `pi.tokens.*` / `pi.cost.usd`.
 * - `CronScheduler.tick()` over a fake pg pool → `pi.scheduler.tick` + `pi.job.run`.
 * - `WebhookDispatcher.tick()` over a fake pg pool → `pi.webhook.delivery`.
 *
 * The pg pools are fakes; the domain code under test is not.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LookupAddress } from "node:dns";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeSDK, tracing, metrics as sdkMetrics } from "@opentelemetry/sdk-node";
import type { AgentConfig, Environment } from "@pi-managed/contracts";
import {
  FakeObjectStore,
  FakeSandboxProvider,
  FakeSecretStore,
  FakeUsageRecorder,
} from "@pi-managed/testkit";

import { MetricNames, SpanAttrs, SpanNames } from "../conventions.js";
import { ManagedSessionRuntime } from "../../../domain/session-manager/runtime.js";
import { InMemorySessionStore } from "../../../domain/session-manager/session-store.js";
import type {
  ResolvedAgentMaterial,
  SessionRecord,
} from "../../../domain/session-manager/types.js";
import { FakeAgentSessionFactory } from "../../../domain/session-manager/__tests__/fake-agent-session.js";
import { MicrosandboxProvider } from "../../sandbox/provider.js";
import type { Pool, PoolClient } from "../../db/index.js";
import { PgUsageRecorder } from "../../../domain/usage/usage-recorder.js";
import { CronScheduler } from "../../../domain/scheduler/tick.js";
import type { JobRow } from "../../../domain/scheduler/job-service.js";
import { WebhookDispatcher } from "../../../domain/webhook/dispatcher.js";
import { getDefaultVaultCrypto } from "../../../domain/vault/crypto.js";

// ---------------------------------------------------------------------------
// The `microsandbox` NAPI SDK — mocked so the provider's own code runs without KVM.
// ---------------------------------------------------------------------------

const msbCalls: string[] = [];

vi.mock("microsandbox", () => {
  const builder: Record<string, unknown> = {};
  for (const m of [
    "image",
    "cpus",
    "memory",
    "labels",
    "detached",
    "replace",
    "volume",
    "envs",
    "secret",
    "network",
  ]) {
    builder[m] = () => builder;
  }
  builder.create = async (): Promise<void> => {
    msbCalls.push("create");
  };

  const handle = {
    status: "running",
    connect: async () => ({
      execWith: async () => ({
        stdout: () => "hello",
        stderr: () => "",
        code: 0,
      }),
    }),
    stop: async (): Promise<void> => {
      msbCalls.push("stop");
    },
    kill: async (): Promise<void> => {
      msbCalls.push("kill");
    },
    waitUntilStopped: async (): Promise<void> => {},
    remove: async (): Promise<void> => {
      msbCalls.push("remove");
    },
    snapshot: async () => ({ digest: "sha256:deadbeef", path: "/snap" }),
  };

  return {
    Sandbox: {
      builder: () => builder,
      get: async () => handle,
      startDetached: async (): Promise<void> => {
        msbCalls.push("startDetached");
      },
      listWith: async () => [],
    },
  };
});

// ---------------------------------------------------------------------------
// OTEL harness — the real NodeSDK, in-memory exporters.
// ---------------------------------------------------------------------------

const spanExporter = new tracing.InMemorySpanExporter();
/**
 * Kept so assertions can `forceFlush()` it. `SimpleSpanProcessor.onEnd` hands the span
 * to the exporter ASYNCHRONOUSLY, so reading `getFinishedSpans()` straight after the
 * code under test returns races the export and sees an empty list.
 */
const spanProcessor = new tracing.SimpleSpanProcessor(spanExporter);
const metricReader = new sdkMetrics.PeriodicExportingMetricReader({
  exporter: new sdkMetrics.InMemoryMetricExporter(
    sdkMetrics.AggregationTemporality.CUMULATIVE,
  ),
  // Long interval: the test collects on demand (`reader.collect()`), not on the timer.
  exportIntervalMillis: 600_000,
});

let sdk: NodeSDK;

beforeAll(() => {
  sdk = new NodeSDK({
    spanProcessors: [spanProcessor],
    metricReaders: [metricReader],
  });
  sdk.start();
});

afterAll(async () => {
  await sdk.shutdown();
});

beforeEach(() => {
  spanExporter.reset();
  msbCalls.length = 0;
});

type FinishedSpan = ReturnType<typeof spanExporter.getFinishedSpans>[number];

/** Flush the processor, then snapshot every span exported so far in this test. */
async function finishedSpans(): Promise<FinishedSpan[]> {
  await spanProcessor.forceFlush();
  return spanExporter.getFinishedSpans();
}

/** Every span in `spans` with `name`. */
function spansNamed(spans: FinishedSpan[], name: string): FinishedSpan[] {
  return spans.filter((s) => s.name === name);
}

/** The single span with `name` (fails the test if there is not exactly one). */
function oneSpan(spans: FinishedSpan[], name: string): FinishedSpan {
  const found = spansNamed(spans, name);
  expect(
    found.map(() => name),
    `expected exactly one "${name}" span, saw ${found.length} ` +
      `(all: ${spans.map((s) => s.name).join(", ")})`,
  ).toHaveLength(1);
  return found[0];
}

/**
 * The parent span id of a finished span. `@opentelemetry/sdk-trace-base` v2 renamed
 * `parentSpanId` → `parentSpanContext`; read either so the assertion survives the SDK
 * minor that ships.
 */
function parentIdOf(span: FinishedSpan): string | undefined {
  const s = span as unknown as {
    parentSpanContext?: { spanId?: string };
    parentSpanId?: string;
  };
  return s.parentSpanContext?.spanId ?? s.parentSpanId;
}

/** All data points currently recorded for metric `name`. */
async function metricPoints(
  name: string,
): Promise<{ value: number; attributes: Record<string, unknown> }[]> {
  const collected = await metricReader.collect();
  const out: { value: number; attributes: Record<string, unknown> }[] = [];
  for (const scope of collected.resourceMetrics.scopeMetrics) {
    for (const metric of scope.metrics) {
      if (metric.descriptor.name !== name) continue;
      for (const dp of metric.dataPoints) {
        out.push({
          value: dp.value as number,
          attributes: dp.attributes as Record<string, unknown>,
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Session lifecycle: wake → turn → model request → tool
// ---------------------------------------------------------------------------

function makeEnvironment(): Environment {
  return {
    id: "env_test",
    name: "test-env",
    type: "cloud",
    status: "active",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    image: "ubuntu:22.04",
    resources: { cpus: 1, memoryMiB: 512 },
    networking: { mode: "unrestricted" },
  };
}

function makeRuntime(): {
  runtime: ManagedSessionRuntime;
  factory: FakeAgentSessionFactory;
} {
  const dir = mkdtempSync(join(tmpdir(), "pi-otel-test-"));
  const jsonlPath = join(dir, "session.jsonl");
  writeFileSync(
    jsonlPath,
    `{"type":"session","version":3,"id":"abc","timestamp":"2026-07-13T00:00:00.000Z","cwd":"${dir}"}\n`,
  );

  const material: ResolvedAgentMaterial = {
    agentConfig: {
      model: { provider: "anthropic", id: "claude-sonnet-4-5" },
    } as AgentConfig,
    providerKeys: { anthropic: "sk-test" },
    cwd: tmpdir(),
  };
  const record: SessionRecord = {
    sessionId: "sess_otel",
    tenantId: "tnt_otel",
    localJsonlPath: jsonlPath,
    objectStoreKey: "sessions/sess_otel/session.jsonl",
    material,
    environment: makeEnvironment(),
    vaultIds: ["vlt_1"],
  };
  const sessions = new InMemorySessionStore();
  sessions.seed(record);

  const factory = new FakeAgentSessionFactory();
  const runtime = new ManagedSessionRuntime({
    sandbox: new FakeSandboxProvider(),
    objects: new FakeObjectStore(),
    usage: new FakeUsageRecorder(),
    secrets: new FakeSecretStore(),
    sessions,
    factory,
  });
  return { runtime, factory };
}

describe("session lifecycle spans", () => {
  it("emits wake/turn/model-request/tool spans, correctly nested", async () => {
    const { runtime, factory } = makeRuntime();

    await runtime.wake("sess_otel");

    const afterWake = await finishedSpans();

    // `pi.session.wake` closed with the session + tenant on it.
    const wake = oneSpan(afterWake, SpanNames.SESSION_WAKE);
    expect(wake.attributes[SpanAttrs.SESSION_ID]).toBe("sess_otel");
    expect(wake.attributes[SpanAttrs.TENANT_ID]).toBe("tnt_otel");

    // Vault resolution happened inside the wake, and nests under it.
    const vault = oneSpan(afterWake, SpanNames.VAULT_RESOLVE);
    expect(parentIdOf(vault)).toBe(wake.spanContext().spanId);
    expect(vault.attributes["pi.vault.count"]).toBe(1);

    // Drive a real turn: the Pi event stream the runtime maps is scripted.
    factory.last.scriptTurn(
      { type: "turn_start" },
      {
        type: "tool_execution_start",
        toolCallId: "tc_1",
        toolName: "bash",
        args: {},
      },
      {
        type: "tool_execution_end",
        toolCallId: "tc_1",
        toolName: "bash",
        result: "ok",
        isError: false,
      },
      {
        type: "turn_end",
        message: {
          model: "claude-sonnet-4-5",
          usage: { input: 100, output: 20 },
        },
      },
    );

    await runtime.sendEvent({
      type: "user.message",
      id: "evt_1",
      createdAt: new Date().toISOString(),
      payload: { content: "hello" },
    });

    const spans = await finishedSpans();

    const turn = oneSpan(spans, SpanNames.SESSION_TURN);
    expect(turn.attributes[SpanAttrs.SESSION_ID]).toBe("sess_otel");
    expect(turn.attributes[SpanAttrs.STOP_REASON]).toBe("completed");

    const model = oneSpan(spans, SpanNames.MODEL_REQUEST);
    expect(model.attributes[SpanAttrs.MODEL_NAME]).toBe("claude-sonnet-4-5");
    expect(parentIdOf(model)).toBe(turn.spanContext().spanId);

    // `pi.tool.<name>` — the sanitized tool name, nested under the model request.
    const tool = oneSpan(spans, "pi.tool.bash");
    expect(tool.attributes[SpanAttrs.TOOL_NAME]).toBe("bash");
    expect(parentIdOf(tool)).toBe(model.spanContext().spanId);

    // The whole turn is one trace.
    expect(model.spanContext().traceId).toBe(turn.spanContext().traceId);
    expect(tool.spanContext().traceId).toBe(turn.spanContext().traceId);

    runtime.dispose();
  });

  it("records the model-request duration histogram and the active-session gauge", async () => {
    // The reader is CUMULATIVE and shared by the whole file, so assert on the DELTA
    // this test causes rather than an absolute the test order could shift.
    const sessionsActive = async (): Promise<number> => {
      const points = await metricPoints(MetricNames.SESSIONS_ACTIVE);
      return (
        points.find((p) => p.attributes[SpanAttrs.TENANT_ID] === "tnt_otel")?.value ??
        0
      );
    };
    const before = await sessionsActive();

    const { runtime, factory } = makeRuntime();
    await runtime.wake("sess_otel");

    expect(await sessionsActive()).toBe(before + 1);

    factory.last.scriptTurn(
      { type: "turn_start" },
      {
        type: "turn_end",
        message: { model: "claude-sonnet-4-5", usage: { input: 1, output: 1 } },
      },
    );
    await runtime.sendEvent({
      type: "user.message",
      id: "evt_1",
      createdAt: new Date().toISOString(),
      payload: { content: "hi" },
    });

    const durations = await metricPoints(MetricNames.MODEL_REQUEST_DURATION);
    expect(durations.length).toBeGreaterThan(0);
    expect(durations.at(-1)?.attributes[SpanAttrs.MODEL_NAME]).toBe(
      "claude-sonnet-4-5",
    );

    // dispose() balances the UpDownCounter back down.
    runtime.dispose();
    expect(await sessionsActive()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 2. Sandbox lifecycle (real MicrosandboxProvider, mocked msb SDK)
// ---------------------------------------------------------------------------

describe("sandbox lifecycle spans", () => {
  const handle = { id: "tnt_a-sess_b", name: "tnt_a-sess_b" };

  it("emits provision/exec/checkpoint/start/snapshot/destroy spans", async () => {
    const provider = new MicrosandboxProvider();

    const provisioned = await provider.provision({
      name: "tnt_a-sess_b",
      image: "ubuntu:22.04",
      cpus: 1,
      memoryMiB: 512,
      networkPolicy: { mode: "unrestricted" },
      labels: { tenant: "tnt_a", session: "sess_b" },
      detached: true,
    });
    expect(provisioned.id).toBe("tnt_a-sess_b");

    const result = await provider.exec(handle, { cmd: ["echo", "hello"] });
    expect(result.exitCode).toBe(0);

    await provider.stop(handle);
    await provider.start(handle);
    await provider.snapshot(handle);
    await provider.destroy(handle);

    // The msb SDK really was driven (the spans wrap live calls, not stubs).
    expect(msbCalls).toContain("create");
    expect(msbCalls).toContain("stop");
    expect(msbCalls).toContain("remove");

    const spans = await finishedSpans();

    const provision = oneSpan(spans, SpanNames.SANDBOX_PROVISION);
    expect(provision.attributes[SpanAttrs.SANDBOX_ID]).toBe("tnt_a-sess_b");
    expect(provision.attributes[SpanAttrs.TENANT_ID]).toBe("tnt_a");
    expect(provision.attributes[SpanAttrs.SESSION_ID]).toBe("sess_b");

    const exec = oneSpan(spans, SpanNames.SANDBOX_EXEC);
    expect(exec.attributes["pi.sandbox.exit_code"]).toBe(0);

    for (const name of [
      SpanNames.SANDBOX_CHECKPOINT,
      SpanNames.SANDBOX_START,
      SpanNames.SANDBOX_SNAPSHOT,
      SpanNames.SANDBOX_DESTROY,
    ]) {
      expect(oneSpan(spans, name).attributes[SpanAttrs.SANDBOX_ID]).toBe(
        "tnt_a-sess_b",
      );
    }
  });

  it("records the running-sandbox gauge and sets an error span on failure", async () => {
    const provider = new MicrosandboxProvider();
    await provider.provision({
      name: "tnt_a-sess_g",
      image: "ubuntu:22.04",
      cpus: 1,
      memoryMiB: 512,
      networkPolicy: { mode: "unrestricted" },
      labels: { tenant: "tnt_a", session: "sess_g" },
      detached: true,
    });
    const running = await metricPoints(MetricNames.SANDBOXES_RUNNING);
    expect(
      running.find((p) => p.attributes[SpanAttrs.SANDBOX_ID] === "tnt_a-sess_g")
        ?.value,
    ).toBe(1);

    // A provision that throws (the §25.1 volume guard) must still close its span,
    // with ERROR status — and must still throw.
    await expect(
      provider.provision({
        name: "tnt_a-sess_bad",
        image: "ubuntu:22.04",
        cpus: 1,
        memoryMiB: 512,
        volumes: [{ source: "/etc", guestPath: "/mnt/x" }],
        networkPolicy: { mode: "unrestricted" },
        labels: { tenant: "tnt_a", session: "sess_bad" },
        detached: true,
      }),
    ).rejects.toThrow(/non-managed source/);

    const failed = spansNamed(
      await finishedSpans(),
      SpanNames.SANDBOX_PROVISION,
    ).find((s) => s.attributes[SpanAttrs.SANDBOX_ID] === "tnt_a-sess_bad");
    expect(failed).toBeDefined();
    expect(failed?.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(failed?.events.map((e) => e.name)).toContain("exception");
  });
});

// ---------------------------------------------------------------------------
// 3. Usage recorder — per-tenant token + cost metrics
// ---------------------------------------------------------------------------

/** A pg `Pool` double: `query` answers from `handler`, `connect` yields a client. */
function fakePool(
  handler: (sql: string, params: unknown[]) => { rows: unknown[]; rowCount?: number },
): Pool {
  const query = async (
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: unknown[]; rowCount: number }> => {
    const res = handler(sql, params);
    return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
  };
  return {
    query,
    connect: async (): Promise<PoolClient> =>
      ({ query, release: () => {} }) as unknown as PoolClient,
  } as unknown as Pool;
}

describe("usage recorder metrics", () => {
  it("records pi.tokens.* and pi.cost.usd with the tenant + model attributes", async () => {
    const recorder = new PgUsageRecorder({
      pool: fakePool((sql) => {
        if (sql.includes("SELECT tenant_id FROM sessions")) {
          return { rows: [{ tenant_id: "tnt_usage" }] };
        }
        return { rows: [] }; // the usage_records INSERT
      }),
    });

    const tokens = {
      inputTokens: 1_000,
      outputTokens: 500,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    // The cost metric must carry the SAME USD the recorder writes to `usage_records`,
    // so the expectation is derived from the recorder's own price table.
    const expectedUsd = recorder.usdCost("claude-sonnet-4-5", tokens);
    expect(expectedUsd).toBeGreaterThan(0);

    await recorder.record("sess_usage", "claude-sonnet-4-5", tokens);

    const input = await metricPoints(MetricNames.TOKENS_INPUT);
    const mine = input.find(
      (p) => p.attributes[SpanAttrs.TENANT_ID] === "tnt_usage",
    );
    expect(mine?.value).toBe(1_000);
    expect(mine?.attributes[SpanAttrs.MODEL_NAME]).toBe("claude-sonnet-4-5");

    const output = await metricPoints(MetricNames.TOKENS_OUTPUT);
    expect(
      output.find((p) => p.attributes[SpanAttrs.TENANT_ID] === "tnt_usage")?.value,
    ).toBe(500);

    const cost = await metricPoints(MetricNames.COST_USD);
    expect(
      cost.find((p) => p.attributes[SpanAttrs.TENANT_ID] === "tnt_usage")?.value,
    ).toBeCloseTo(expectedUsd, 6);
  });
});

// ---------------------------------------------------------------------------
// 4. Scheduler — tick + job run
// ---------------------------------------------------------------------------

describe("scheduler spans", () => {
  it("emits pi.scheduler.tick with a nested pi.job.run and a job-outcome metric", async () => {
    const now = new Date("2026-07-14T12:00:00.000Z");
    const job: JobRow = {
      tenant_id: "tnt_job",
      id: "job_1",
      name: "nightly",
      agent_id: "agt_1",
      agent_version: 1,
      environment_id: "env_1",
      initial_events: [],
      session_config: {},
      schedule_cron: "* * * * *",
      schedule_tz: "UTC",
      one_shot: false,
      status: "active",
      paused_reason: null,
      // Two minutes back: inside the 5-minute catch-up window, so the occurrences
      // in between are due now.
      created_at: new Date(now.getTime() - 2 * 60_000),
      updated_at: new Date(now.getTime() - 2 * 60_000),
    };

    const scheduler = new CronScheduler({
      pool: fakePool((sql) => {
        if (sql.includes("FROM job_runs r")) return { rows: [] }; // recovery scan
        // PERF-6: active jobs + their cron cursor (`last_scheduled_at`) resolve in ONE
        // batched query (`FROM jobs j LEFT JOIN … MAX(scheduled_at)`), not a per-job scan.
        if (sql.includes("FROM jobs j"))
          return { rows: [{ ...job, last_scheduled_at: null }] };
        if (sql.includes("INSERT INTO job_runs")) return { rows: [{ id: "jr_1" }] };
        // The agent is archived → executeJobRun returns a `failed` outcome (§17.4)
        // without throwing, which is exactly the path the span/metric must report.
        if (sql.includes("FROM agents")) return { rows: [{ status: "archived" }] };
        return { rows: [] }; // run-error UPDATE, auto-pause UPDATE, triggered_at UPDATE, heartbeat
      }),
      clock: { now: () => now },
    });

    await scheduler.tick();

    const spans = await finishedSpans();
    const tick = oneSpan(spans, SpanNames.SCHEDULER_TICK);
    expect(tick.attributes["pi.scheduler.active_jobs"]).toBe(1);

    const runs = spansNamed(spans, SpanNames.JOB_RUN);
    expect(runs.length).toBeGreaterThan(0);
    const run = runs[0];
    expect(run.attributes[SpanAttrs.JOB_ID]).toBe("job_1");
    expect(run.attributes[SpanAttrs.TENANT_ID]).toBe("tnt_job");
    expect(run.attributes[SpanAttrs.OUTCOME]).toBe("failed");
    expect(run.attributes["pi.job.error"]).toBe("agent_archived");
    expect(parentIdOf(run)).toBe(tick.spanContext().spanId);

    const outcomes = await metricPoints(MetricNames.JOB_RUNS);
    const failed = outcomes.find(
      (p) =>
        p.attributes[SpanAttrs.JOB_ID] === "job_1" &&
        p.attributes[SpanAttrs.OUTCOME] === "failed",
    );
    expect(failed?.value).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Webhook dispatcher — delivery span + outcome metric
// ---------------------------------------------------------------------------

const PUBLIC_RESOLVER = async (): Promise<LookupAddress[]> => [
  { address: "8.8.8.8", family: 4 },
];

/** The stored (encrypted) signing secret, in the exact shape the dispatcher decrypts. */
function storedSecret(secret: string): string {
  const enc = getDefaultVaultCrypto().encrypt(secret);
  return JSON.stringify({
    ciphertext: enc.ciphertext.toString("base64"),
    nonce: enc.nonce.toString("base64"),
    keyId: enc.keyId,
  });
}

describe("webhook dispatcher spans", () => {
  it("emits pi.webhook.delivery and counts the succeeded outcome", async () => {
    const delivery = {
      id: "whd_1",
      tenant_id: "tnt_wh",
      webhook_id: "whk_1",
      event_id: "evt_1",
      event_type: "session.completed",
      payload: {
        type: "session.completed",
        id: "evt_1",
        createdAt: "2026-07-14T12:00:00.000Z",
      },
      attempt: 1,
    };

    const dispatcher = new WebhookDispatcher({
      pool: fakePool((sql) => {
        if (sql.includes("SELECT id FROM webhook_deliveries")) {
          return { rows: [{ id: "whd_1" }] };
        }
        if (sql.includes("SET status = 'delivering'")) return { rows: [delivery] };
        if (sql.includes("FROM webhooks")) {
          return {
            rows: [
              {
                id: "whk_1",
                url: "https://hooks.example.com/x",
                signing_secret_hash: storedSecret("s3kret"),
                event_types: ["session.completed"],
                status: "active",
                disabled_reason: null,
                created_at: new Date(),
                updated_at: new Date(),
              },
            ],
          };
        }
        return { rows: [] }; // BEGIN/COMMIT, reaper, markSucceeded
      }),
      dnsResolver: PUBLIC_RESOLVER,
      fetchImpl: (async () =>
        new Response("", { status: 200 })) as unknown as typeof fetch,
    });

    await dispatcher.tick();

    const span = oneSpan(await finishedSpans(), SpanNames.WEBHOOK_DELIVERY);
    expect(span.attributes[SpanAttrs.WEBHOOK_ID]).toBe("whk_1");
    expect(span.attributes[SpanAttrs.TENANT_ID]).toBe("tnt_wh");
    expect(span.attributes[SpanAttrs.EVENT_TYPE]).toBe("session.completed");

    const points = await metricPoints(MetricNames.WEBHOOK_DELIVERIES);
    const succeeded = points.find(
      (p) =>
        p.attributes[SpanAttrs.WEBHOOK_ID] === "whk_1" &&
        p.attributes[SpanAttrs.OUTCOME] === "succeeded",
    );
    expect(succeeded?.value).toBeGreaterThanOrEqual(1);
    expect(succeeded?.attributes[SpanAttrs.HTTP_STATUS_CODE]).toBe(200);
  });
});
