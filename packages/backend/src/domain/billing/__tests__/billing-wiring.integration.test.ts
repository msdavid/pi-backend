/**
 * W8.2 — the billing metering hook is actually wired by the composition root.
 *
 * The audit finding was dead wiring: `domain/billing/` existed (sink interface,
 * no-op + webhook impls, `createMeteringHook`) and `usage-recorder.ts` accepted an
 * `onMetering` callback, but `app.ts` never passed one — so no metering event could
 * ever reach a sink. These tests prove the seam end-to-end through the REAL composed
 * app (`createManagedApp`) against a real Postgres:
 *
 * - `BILLING_SINK=webhook`: a real turn through the session runtime records real usage
 *   (a `usage_records` row) and the {@link WebhookBillingSink} posts a signed
 *   {@link MeteringEvent} to the configured endpoint, carrying an `X-Metering-Id` that
 *   is **stable across retries** (the dedup key its docstring promises).
 * - default (`BILLING_SINK` unset ⇒ `none`): the same turn records the same usage and
 *   the sink is a no-op — no egress at all (existing behavior unchanged).
 *
 * Egress is routed to a local mock endpoint via an injected `fetchImpl` + a public DNS
 * resolver (the sink now goes through the shared SSRF-pinned transport, which would
 * otherwise refuse a loopback address) — same technique the webhook-dispatcher loop
 * test uses.
 *
 * Skips when no container runtime is available (keeps `pnpm test` green in dev). The
 * config/no-container assertions below run unconditionally.
 */

import http from "node:http";
import { type AddressInfo } from "node:net";
import type { LookupAddress } from "node:dns";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pino from "pino";
import { FakeSandboxProvider } from "@pi-managed/testkit";
import { loadConfig, type Config } from "../../../infra/config/index.js";
import { query, type Pool, type TenantCtx } from "../../../infra/db/index.js";
import {
  startPostgres,
  hasContainerRuntime,
  type TestDb,
} from "../../../infra/db/__tests__/test-runtime.js";
import { createManagedApp, type ManagedApp } from "../../../app.js";
import { FakeAgentSessionFactory } from "../../session-manager/__tests__/fake-agent-session.js";
import { createTenant } from "../../tenant/tenant.js";
import { createAgent } from "../../agent/agent.js";
import { createEnvironment } from "../../environment/environment.js";
import { createSession } from "../../session/index.js";
import { verifyWebhookSignature } from "../../webhook/index.js";
import { createBillingSink } from "../from-config.js";
import { NOOP_BILLING_SINK } from "../noop-sink.js";
import type { MeteringEvent } from "../sink.js";

const TEST_KEY = "0".repeat(64);
const SECRET = "whsec_01JBILLINGTESTSECRET_0123456789ABCDEFGHJKMNPQRSTUVWXYZ";
const BILLING_ENDPOINT = "https://billing.example.com/metering";
const MODEL = "claude-sonnet-4-5";
const silentLogger = pino({ level: "silent" });

/** A public resolver so the sink's SSRF guard passes for the fake billing host. */
const PUBLIC_RESOLVER = async (): Promise<LookupAddress[]> => [
  { address: "8.8.8.8", family: 4 },
];

interface Received {
  body: string;
  meteringId: string;
  signature: string;
}

/** Mock billing endpoint. Fails the first delivery so the retry path is exercised. */
interface MockBilling {
  url: string;
  server: http.Server;
  received: Received[];
  failFirst: boolean;
}

async function startMockBilling(failFirst: boolean): Promise<MockBilling> {
  const mock: MockBilling = {
    url: "",
    server: http.createServer(),
    received: [],
    failFirst,
  };
  mock.server.on("request", (req, res) => {
    let body = "";
    req.on("data", (c) => (body += c.toString()));
    req.on("end", () => {
      mock.received.push({
        body,
        meteringId: req.headers["x-metering-id"] as string,
        signature: req.headers["x-webhook-signature"] as string,
      });
      // First delivery 500s → the sink retries with the SAME X-Metering-Id.
      res.writeHead(mock.failFirst && mock.received.length === 1 ? 500 : 200);
      res.end();
    });
  });
  await new Promise<void>((r) => mock.server.listen(0, "127.0.0.1", () => r()));
  const port = (mock.server.address() as AddressInfo).port;
  mock.url = `http://127.0.0.1:${port}`;
  return mock;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 6000,
): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A `user.message` inbound event (ports shape). */
function userMessage(content: string) {
  return {
    type: "user.message" as const,
    id: `evt_${Math.random()}`,
    createdAt: new Date().toISOString(),
    payload: { content },
  };
}

// ---------------------------------------------------------------------------
// Config → sink selection (no container needed)
// ---------------------------------------------------------------------------

describe("billing config → sink selection (W8.2)", () => {
  it("defaults to the no-op sink (billing disabled) when BILLING_SINK is unset", () => {
    const config = loadConfig({ env: {} });
    expect(config.billingSink).toBe("none");
    expect(createBillingSink(config, silentLogger)).toBe(NOOP_BILLING_SINK);
  });

  it("BILLING_SINK=webhook builds the webhook sink from the configured URL + secret", () => {
    const config = loadConfig({
      env: {
        BILLING_SINK: "webhook",
        BILLING_WEBHOOK_URL: BILLING_ENDPOINT,
        BILLING_WEBHOOK_SECRET: SECRET,
      },
    });
    expect(config.billingWebhookUrl).toBe(BILLING_ENDPOINT);
    const sink = createBillingSink(config, silentLogger);
    expect(sink).not.toBe(NOOP_BILLING_SINK);
    expect(sink.constructor.name).toBe("WebhookBillingSink");
  });

  it("BILLING_SINK=webhook without a URL/secret is a boot error (never a silent drop)", () => {
    const config = loadConfig({ env: { BILLING_SINK: "webhook" } });
    expect(() => createBillingSink(config, silentLogger)).toThrow(
      /BILLING_WEBHOOK_URL/,
    );
  });
});

// ---------------------------------------------------------------------------
// End-to-end: usage recorded through the composed app → the sink receives it
// ---------------------------------------------------------------------------

const d = hasContainerRuntime() ? describe : describe.skip;

d("billing metering hook wired by the composition root (W8.2)", () => {
  let db: TestDb;
  let mock: MockBilling;

  beforeAll(async () => {
    process.env.VAULT_KEY = TEST_KEY;
    db = await startPostgres();
    mock = await startMockBilling(true); // 500 the first delivery → retry path
  }, 120_000);

  afterAll(async () => {
    if (mock) await new Promise<void>((r) => mock.server.close(() => r()));
    await db?.container.stop();
  });

  /** Compose the real app with the fakes the harness cannot provide (KVM, model). */
  async function compose(
    billing: Partial<Config>,
    factory: FakeAgentSessionFactory,
    billingSinkOptions?: Parameters<typeof createManagedApp>[0]["billingSinkOptions"],
  ): Promise<ManagedApp> {
    const config = {
      port: 3000,
      logLevel: "silent",
      objectStoreRoot: "./data/objectstore",
      sandboxRuntime: "disabled",
      dbUrl: db.connectionString,
      billingSink: "none",
      ...billing,
    } as Config;
    return createManagedApp({
      config,
      logger: silentLogger,
      sandboxProvider: new FakeSandboxProvider(),
      factory,
      revalidationIntervalMs: 0,
      ...(billingSinkOptions ? { billingSinkOptions } : {}),
    });
  }

  /** Stage a tenant + agent + environment + session on the composed app. */
  async function stageSession(
    pool: Pool,
    name: string,
  ): Promise<{ ctx: TenantCtx; sessionId: string }> {
    const tenant = await createTenant(pool, { name });
    const ctx: TenantCtx = { tenantId: tenant.id };
    const agent = await createAgent(pool, ctx, {
      name: `${name}-agent`,
      model: { provider: "anthropic", id: MODEL },
    });
    const env = await createEnvironment(pool, ctx, {
      name: `${name}-env`,
      type: "cloud",
    });
    const session = await createSession(pool, ctx, {
      agent: agent.id,
      environmentId: env.id,
    });
    return { ctx, sessionId: session.id };
  }

  /**
   * Drive one real turn through the composed app's session runtime. The scripted
   * `turn_end` carries usage, which is exactly what makes the REAL
   * `ManagedSessionRuntime` call the REAL `UsageRecorder.record()` — the call site the
   * metering hook hangs off. Usage is recorded from `turn_end` only (ROB-7: recording
   * from BOTH `turn_end` and `agent_end` double-counted the same assistant message), so
   * this one turn produces exactly one usage record.
   */
  async function driveTurn(
    managed: ManagedApp,
    factory: FakeAgentSessionFactory,
    sessionId: string,
  ): Promise<void> {
    const rt = await managed.sessionManager.getOrCreate(sessionId);
    factory.last.scriptTurn(
      { type: "turn_start" },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "hi" },
      },
      { type: "message_end" },
      {
        type: "turn_end",
        message: {
          model: MODEL,
          usage: { input: 1000, output: 500, cacheRead: 10, cacheWrite: 5 },
        },
      },
      {
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            model: MODEL,
            usage: { input: 1000, output: 500, cacheRead: 10, cacheWrite: 5 },
          },
        ],
        willRetry: false,
      },
    );
    await rt.sendEvent(userMessage("hello"));
  }

  it("BILLING_SINK=webhook: a real turn's usage reaches the sink as a signed metering event", async () => {
    const factory = new FakeAgentSessionFactory();
    const managed = await compose(
      {
        billingSink: "webhook",
        billingWebhookUrl: BILLING_ENDPOINT,
        billingWebhookSecret: SECRET,
      },
      factory,
      {
        // Route the (SSRF-validated) delivery to the local mock; the public resolver
        // satisfies the pinned guard for `billing.example.com`.
        fetchImpl: ((_input: unknown, init?: RequestInit) =>
          fetch(`${mock.url}/metering`, init)) as unknown as typeof fetch,
        dnsResolver: PUBLIC_RESOLVER,
        backoff: () => 0,
      },
    );

    try {
      const { ctx, sessionId } = await stageSession(managed.pool, "billing-webhook");
      await driveTurn(managed, factory, sessionId);

      // Real usage was recorded (the hook fires only after a successful record()).
      const { rows } = await query<{ n: string; usd: string }>(
        managed.pool,
        `SELECT count(*) AS n, COALESCE(SUM(usd_cost), 0) AS usd
           FROM usage_records WHERE session_id = $1`,
        [sessionId],
      );
      expect(Number(rows[0].n)).toBe(1);
      expect(Number(rows[0].usd)).toBeGreaterThan(0);

      // The metering event reached the billing sink (fire-and-forget → poll).
      // Delivery 1 is 500'd, delivery 2 acks: at-least-once, same dedup id.
      const delivered = await waitFor(() => mock.received.length >= 2);
      expect(delivered).toBe(true);
      expect(mock.received).toHaveLength(2);

      // X-Metering-Id: `met_` prefixed and STABLE across the retry (dedup key).
      const ids = new Set(mock.received.map((r) => r.meteringId));
      expect(ids.size).toBe(1);
      expect([...ids][0]).toMatch(/^met_/);

      // The body is the MeteringEvent for the usage just recorded, HMAC-signed.
      const first = mock.received[0];
      const event = JSON.parse(first.body) as MeteringEvent;
      expect(event.tenantId).toBe(ctx.tenantId);
      expect(event.sessionId).toBe(sessionId);
      expect(event.model).toBe(MODEL);
      expect(event.inputTokens).toBe(1000);
      expect(event.outputTokens).toBe(500);
      expect(event.usdCost).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(event.recordedAt))).toBe(false);
      expect(
        verifyWebhookSignature(first.body, first.signature, SECRET).ok,
      ).toBe(true);

      // Both deliveries carry the identical body (retry, not a new event).
      expect(mock.received[1].body).toBe(first.body);
    } finally {
      await managed.close();
    }
  }, 60_000);

  it("default (BILLING_SINK=none): usage is still recorded and the sink is a no-op (no egress)", async () => {
    const before = mock.received.length;
    const factory = new FakeAgentSessionFactory();
    const managed = await compose({}, factory, {
      // Even with a routed fetch available, the no-op sink must never call it.
      fetchImpl: ((_input: unknown, init?: RequestInit) =>
        fetch(`${mock.url}/metering`, init)) as unknown as typeof fetch,
      dnsResolver: PUBLIC_RESOLVER,
    });

    try {
      const { sessionId } = await stageSession(managed.pool, "billing-noop");
      await driveTurn(managed, factory, sessionId);

      const { rows } = await query<{ n: string }>(
        managed.pool,
        `SELECT count(*) AS n FROM usage_records WHERE session_id = $1`,
        [sessionId],
      );
      expect(Number(rows[0].n)).toBe(1);

      // Give a stray delivery every chance to land, then assert none did.
      const leaked = await waitFor(() => mock.received.length > before, 500);
      expect(leaked).toBe(false);
      expect(mock.received.length).toBe(before);
    } finally {
      await managed.close();
    }
  }, 60_000);
});
