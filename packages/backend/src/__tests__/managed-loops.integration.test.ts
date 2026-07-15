/**
 * R2.3 — background loops wired by the real composition root.
 *
 * Drives {@link createManagedApp} against a real Postgres (testcontainers/podman) with a
 * `FakeSandboxProvider` + `FakeAgentSessionFactory` (no KVM, no model). Proves the three
 * loops the composition root now starts:
 *
 * - **scheduler → run row + webhook**: a due cron fires a run (a `job_runs` row) and the
 *   wired {@link createWebhookEventSource} emits `job.run_*`, which the dispatcher loop
 *   delivers as a signed POST (observed via an injected fetch + a public DNS resolver so
 *   the SSRF guard passes).
 * - **outcome → runner grades**: the composition-root outcome runner drives the session
 *   runtime (produce) and the injected grader (grade), persisting a terminal result.
 *
 * Skips when no container runtime is available (keeps `pnpm test` green in dev).
 */

import http from "node:http";
import { type AddressInfo } from "node:net";
import type { LookupAddress } from "node:dns";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pino from "pino";
import type { Config } from "../infra/config/index.js";
import { query, type Pool, type TenantCtx } from "../infra/db/index.js";
import {
  startPostgres,
  hasContainerRuntime,
  type TestDb,
} from "../infra/db/__tests__/test-runtime.js";
import { FakeSandboxProvider } from "@pi-managed/testkit";
import { FakeAgentSessionFactory } from "../domain/session-manager/__tests__/fake-agent-session.js";
import { createManagedApp, type ManagedApp } from "../app.js";
import { createTenant } from "../domain/tenant/tenant.js";
import { createAgent } from "../domain/agent/agent.js";
import { createEnvironment } from "../domain/environment/environment.js";
import { createJob } from "../domain/scheduler/index.js";
import { createSession } from "../domain/session/index.js";
import { defineOutcome } from "../domain/outcome/index.js";
import { createOutcomeRunner } from "../domain/outcome/runner.js";
import { FakeGrader } from "../domain/outcome/index.js";
import { createWebhook, verifyWebhookSignature } from "../domain/webhook/index.js";

const TEST_KEY = "0".repeat(64);
const silentLogger = pino({ level: "silent" });

/** A mock HTTP endpoint capturing signed webhook deliveries. */
interface MockEndpoint {
  url: string;
  server: http.Server;
  received: { body: string; signature: string }[];
}

async function startMockEndpoint(): Promise<MockEndpoint> {
  const received: { body: string; signature: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c.toString()));
    req.on("end", () => {
      received.push({
        body,
        signature: req.headers["x-webhook-signature"] as string,
      });
      res.writeHead(200);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, server, received };
}

/** A public DNS resolver so the dispatcher's SSRF guard passes for the mock. */
const PUBLIC_RESOLVER = async (): Promise<LookupAddress[]> => [
  { address: "8.8.8.8", family: 4 },
];

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 6000,
): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

const d = hasContainerRuntime() ? describe : describe.skip;

d("managed background loops (R2.3)", () => {
  let db: TestDb;
  let managed: ManagedApp;
  let pool: Pool;
  let ctx: TenantCtx;
  let mock: MockEndpoint;
  let agentId: string;
  let envId: string;

  beforeAll(async () => {
    process.env.VAULT_KEY = TEST_KEY;
    db = await startPostgres();
    mock = await startMockEndpoint();

    const config = {
      port: 3000,
      logLevel: "silent",
      objectStoreRoot: "./data/objectstore",
      sandboxRuntime: "disabled",
      dbUrl: db.connectionString,
    } as Config;

    managed = await createManagedApp({
      config,
      logger: silentLogger,
      sandboxProvider: new FakeSandboxProvider(),
      factory: new FakeAgentSessionFactory(),
      schedulerIntervalMs: 80,
      revalidationIntervalMs: 0,
      webhookDispatcherOptions: {
        intervalMs: 80,
        // Route every delivery to the mock endpoint; bypass SSRF with a public IP.
        fetchImpl: ((_input: unknown, init?: RequestInit) =>
          fetch(`${mock.url}/hook`, init)) as unknown as typeof fetch,
        dnsResolver: PUBLIC_RESOLVER,
      },
    });
    pool = managed.pool;

    const tenant = await createTenant(pool, { name: "Loops Tenant" });
    ctx = { tenantId: tenant.id };
    const agent = await createAgent(pool, ctx, {
      name: "loop-agent",
      model: { provider: "anthropic", id: "claude-sonnet-4-5" },
    });
    agentId = agent.id;
    const env = await createEnvironment(pool, ctx, {
      name: "loop-env",
      type: "cloud",
    });
    envId = env.id;
  }, 120_000);

  afterAll(async () => {
    await managed?.close();
    if (mock) await new Promise<void>((r) => mock.server.close(() => r()));
    await db?.container.stop();
  });

  it("scheduler fires a due cron → run row + a signed webhook delivery", async () => {
    // Subscribe to both run outcomes so the delivery is observed regardless of whether
    // createSession succeeds in the fake environment.
    const webhook = await createWebhook(pool, ctx, {
      url: "https://public.example.com/hook",
      eventTypes: ["job.run_succeeded", "job.run_failed"],
    });

    const job = await createJob(pool, ctx, {
      name: "loop-job",
      agent: agentId,
      environmentId: envId,
      initialEvents: [{ type: "user.message", content: "go" }],
      schedule: { cron: "* * * * *", tz: "UTC" },
    });

    // Backdate the job so a due occurrence exists inside the catch-up window (the loop
    // otherwise waits until the next minute boundary).
    await query(
      pool,
      `UPDATE jobs SET created_at = now() - interval '90 seconds' WHERE id = $1`,
      [job.id],
    );

    // The wired scheduler loop fires within a couple of ticks → a run row appears.
    const gotRun = await waitFor(async () => {
      const { rows } = await query<{ n: string }>(
        pool,
        `SELECT count(*) AS n FROM job_runs WHERE job_id = $1 AND triggered_at IS NOT NULL`,
        [job.id],
      );
      return Number(rows[0]?.n ?? 0) > 0;
    });
    expect(gotRun).toBe(true);

    // The wired event source + dispatcher deliver a signed POST to the endpoint.
    const gotDelivery = await waitFor(() => mock.received.length > 0);
    expect(gotDelivery).toBe(true);
    const delivery = mock.received[0];
    expect(delivery.signature).toBeTruthy();
    const verified = verifyWebhookSignature(
      delivery.body,
      delivery.signature,
      webhook.signingSecret,
    );
    expect(verified.ok).toBe(true);
  }, 30_000);

  it("outcome runner drives produce → grade → satisfied", async () => {
    const session = await createSession(pool, ctx, {
      agent: agentId,
      environmentId: envId,
    });

    const outcome = await defineOutcome(pool, ctx, session.id, {
      description: "Write a hello file",
      rubric: { type: "text", content: "A greeting file exists." },
      maxIterations: 1,
    });

    const grader = new FakeGrader();
    grader.script({ verdict: "satisfied", criteria: [], feedback: "" });

    const runner = createOutcomeRunner({
      pool,
      objectStore: managed.objectStore,
      resolveRuntime: (sessionId) => managed.sessionManager.getOrCreate(sessionId),
      grader,
    });

    await runner(ctx, session.id, outcome.id);

    const { rows } = await query<{ status: string; result: string | null }>(
      pool,
      `SELECT status, result FROM session_outcomes WHERE id = $1`,
      [outcome.id],
    );
    expect(rows[0]?.status).toBe("satisfied");
    expect(grader.invocationCount).toBe(1);
  }, 30_000);
});
