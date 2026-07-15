/**
 * R6.6 — self-hosted execution round trip (§10.4, §9.2).
 *
 * Before this WP the work queue was fed by nobody and `postResult` was consumed by
 * nobody: a `self_hosted` session provisioned a cloud VM and the worker's results
 * dead-ended in a jsonb column. This drives the whole loop with real components — real
 * Postgres, the real HTTP routes (`createApp`), the real `ManagedSessionRuntime`, the
 * real materialized toolset, the real work queue. The only fakes are collaborators the
 * loop does not turn on (the object store, the cloud sandbox that must NOT be used, and
 * the model itself):
 *
 *   agent tool call → SelfHostedToolChannel.exec → work item enqueued
 *     → worker POSTs /v1/environments/:id/work-claim (worker key) and sees the tool call
 *     → worker POSTs /v1/sessions/:id/work-result
 *     → the route hands it to the live runtime as `user.tool_result`
 *     → the model's pending tool call resolves with the worker's output.
 *
 * Also asserts the invariant that makes self-hosting *self*-hosted: NO cloud microVM is
 * provisioned; and that the documented unsupported features stay rejected (§13.7).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import pino from "pino";
import { createApp } from "../../../server.js";
import { loadConfig } from "../../../infra/config/index.js";
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
import {
  FakeObjectStore,
  FakeSandboxProvider,
  FakeSecretStore,
  FakeUsageRecorder,
} from "@pi-managed/testkit";
import { createTenant } from "../../tenant/tenant.js";
import { createAgent } from "../../agent/agent.js";
import { createEnvironment } from "../../environment/environment.js";
import { createSession } from "../../session/create.js";
import { ManagedSessionRuntime } from "../../session-manager/runtime.js";
import { InMemorySessionStore } from "../../session-manager/session-store.js";
import type {
  AgentSessionEventLike,
  AgentSessionFactory,
  AgentSessionLike,
  CreateAgentSessionOptions,
  SessionEntryLike,
  SessionRecord,
} from "../../session-manager/types.js";
import type { AgentConfig, Environment } from "@pi-managed/contracts";
import { issueWorkerKey } from "../worker-keys.js";
import {
  createSelfHostedChannelFactory,
  setToolResultSink,
  clearToolResultSink,
  type SelfHostedToolCall,
} from "../work-queue.js";
import { assertSelfHostedSessionConstraints } from "../constraints.js";

const RUNTIME = hasContainerRuntime();

// -- collaborators (never the seam under test) --------------------------------

/** The model is not the subject: the tool call is invoked directly, as Pi would. */
class NoopSession implements AgentSessionLike {
  readonly sessionId = "fake-session";
  readonly sessionFile: string | undefined = undefined;
  isStreaming = false;
  async prompt(): Promise<void> {}
  async steer(): Promise<void> {}
  async followUp(): Promise<void> {}
  subscribe(_l: (e: AgentSessionEventLike) => void): () => void {
    return () => {};
  }
  async abort(): Promise<void> {}
  dispose(): void {}
  getEntries(): SessionEntryLike[] {
    return [];
  }
}

class RecordingFactory implements AgentSessionFactory {
  last?: CreateAgentSessionOptions;
  create(options: CreateAgentSessionOptions): Promise<AgentSessionLike> {
    this.last = options;
    return Promise.resolve(new NoopSession());
  }
}

function baseAgentConfig() {
  return {
    name: "sh-runner",
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

const auth = (key: string) => ({ authorization: `Bearer ${key}` });

describe.skipIf(!RUNTIME)("self-hosted execution round trip (R6.6)", () => {
  let db: TestDb;
  let pool: Pool;
  let app: FastifyInstance;
  let ctx: TenantCtx;
  let envId: string;
  let sessionId: string;
  let environment: Environment;
  let workerKey: string;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
    app = await createApp({
      config: loadConfig({ env: { LOG_LEVEL: "error" } }),
      logger: pino({ level: "error" }),
      pool,
      objectStore: new FakeObjectStore(),
    });
    const t = await createTenant(pool, { name: "SH RoundTrip" });
    ctx = { tenantId: t.id };
    const agent = await createAgent(pool, ctx, baseAgentConfig());
    const env = await createEnvironment(pool, ctx, {
      name: "worker-env",
      type: "self_hosted",
    });
    envId = env.id;
    environment = env;
    const sess = await createSession(pool, ctx, {
      agent: agent.id,
      environmentId: envId,
    });
    sessionId = sess.id;
    workerKey = (await issueWorkerKey(pool, ctx, envId, "worker-1")).key;
  }, 120_000);

  afterAll(async () => {
    clearToolResultSink();
    if (app) await app.close();
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  function seededRecord(): SessionRecord {
    return {
      sessionId,
      tenantId: ctx.tenantId,
      localJsonlPath: join(mkdtempSync(join(tmpdir(), "pi-sh-")), "log.jsonl"),
      objectStoreKey: `sessions/${sessionId}/log.jsonl`,
      material: {
        agentConfig: {
          model: { provider: "anthropic", id: "claude-sonnet-4" },
        } as AgentConfig,
        providerKeys: { anthropic: "sk-test" },
        cwd: "/placeholder",
      },
      environment,
      vaultIds: [],
    };
  }

  it("worker executes the tool and the result resolves the session's tool call", async () => {
    const sessions = new InMemorySessionStore();
    sessions.seed(seededRecord());
    const factory = new RecordingFactory();
    const cloudSandbox = new FakeSandboxProvider();
    const runtime = new ManagedSessionRuntime({
      sandbox: cloudSandbox,
      objects: new FakeObjectStore(),
      usage: new FakeUsageRecorder(),
      secrets: new FakeSecretStore(),
      sessions,
      factory,
      selfHosted: createSelfHostedChannelFactory(pool),
    });

    // The composition-root seam the work-result route delivers through (app.ts registers
    // exactly this, resolving the runtime via the SessionManager).
    setToolResultSink({
      deliver: async (sid, result) => {
        if (sid !== sessionId) return;
        await runtime.sendEvent({
          type: "user.tool_result",
          id: `evt_${crypto.randomUUID()}`,
          createdAt: new Date().toISOString(),
          payload: result,
        });
      },
    });

    await runtime.wake(sessionId);

    // A self_hosted session provisions NO cloud microVM: the toolset is bound to the
    // work-queue channel instead.
    expect(cloudSandbox.calls.filter((c) => c.kind === "provision")).toHaveLength(0);
    expect(runtime.executionProvider).not.toBe(cloudSandbox);

    // The model calls a tool. `grep` is a materialized sandbox tool whose execute() goes
    // straight to `provider.exec` — i.e. through the channel.
    const grep = (factory.last!.material.customTools ?? []).find((t) => t.name === "grep");
    expect(grep).toBeDefined();
    const toolCall = grep!.execute("tc_1", { pattern: "TODO" });

    // The worker polls its queue over HTTP with its worker key and gets the tool call.
    const claimed = await pollClaim(app, envId, workerKey);
    expect(claimed).not.toBeNull();
    const calls = (claimed!.workSpec.toolCalls ?? []) as SelfHostedToolCall[];
    expect(calls).toHaveLength(1);
    expect(String(calls[0].cmd)).toContain("TODO");

    // The worker runs it on its own host and POSTs the result back.
    const posted = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/work-result`,
      headers: auth(workerKey),
      payload: {
        type: "user.tool_result",
        toolUseId: calls[0].toolUseId,
        result: "src/main.ts:12: // TODO: ship it",
        isError: false,
      },
    });
    expect(posted.statusCode).toBe(200);
    // The result is also persisted on the work item (the durable worker channel).
    expect(posted.json().results).toHaveLength(1);

    // …and the model's pending tool call resolves with the worker's output.
    const result = (await toolCall) as { content: Array<{ text: string }> };
    expect(result.content[0].text).toContain("src/main.ts:12");

    runtime.dispose();
    clearToolResultSink();
  }, 60_000);

  it("keeps memory stores rejected on self_hosted environments (§13.7)", async () => {
    await expect(
      assertSelfHostedSessionConstraints(pool, ctx, environment, {
        memoryStoreIds: ["mem_01JAZZZZZZZZZZZZZZZZZZZZZZ"],
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});

/** The worker's poll loop: `POST /v1/environments/:id/work-claim` until an item appears. */
async function pollClaim(app: FastifyInstance, envId: string, key: string) {
  for (let i = 0; i < 50; i++) {
    const res = await app.inject({
      method: "POST",
      url: `/v1/environments/${envId}/work-claim`,
      headers: auth(key),
    });
    if (res.statusCode === 200) {
      return res.json() as { workSpec: { toolCalls?: unknown[] } };
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}
