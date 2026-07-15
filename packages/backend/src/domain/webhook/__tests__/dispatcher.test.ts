/**
 * Webhook dispatcher integration tests (WP-2.5, §23.5).
 *
 * Done-criteria coverage:
 * - retry-idempotency: same `event.id` across retries (one delivery row); a 2xx
 *   ack stops retries (status → succeeded).
 * - auto-disable on private-IP resolution (immediate).
 * - auto-disable on redirect (immediate; redirects not followed).
 * - auto-disable after the ~20-failure streak (consecutive failures).
 *
 * Uses testcontainers-postgres + a mock HTTP server (node:http). The fetch impl
 * is injected so deliveries route to the mock regardless of the registered URL;
 * the DNS resolver is injected so SSRF passes (public) or fails (private) on cue.
 */

import http from "node:http";
import { type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPool,
  closePool,
  query,
  runMigrations,
  type Pool,
  type TenantCtx,
} from "../../../infra/db/index.js";
import { startPostgres, type TestDb } from "../../../infra/db/__tests__/test-runtime.js";
import { createTenant } from "../../tenant/tenant.js";
import { newId } from "../../tenant/ids.js";
import { createWebhook, getWebhook } from "../webhook.js";
import {
  WebhookDispatcher,
} from "../dispatcher.js";
import { verify as verifySignature } from "../signature.js";
import type { LookupAddress } from "node:dns";

const TEST_KEY = "0".repeat(64);

/** A configurable mock HTTP endpoint. */
interface MockEndpoint {
  url: string;
  server: http.Server;
  behavior: { status: number; location?: string };
  received: { body: string; signature: string }[];
}

async function startMockEndpoint(): Promise<MockEndpoint> {
  const behavior = { status: 200 };
  const received: { body: string; signature: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c.toString()));
    req.on("end", () => {
      received.push({
        body,
        signature: req.headers["x-webhook-signature"] as string,
      });
      res.writeHead(behavior.status, behavior.location ? { location: behavior.location } : {});
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, server, behavior, received };
}

/** fetch impl that ignores the webhook URL and POSTs to the mock endpoint. */
function mockFetch(mock: MockEndpoint): typeof fetch {
  return async (_input, init) =>
    fetch(`${mock.url}/hook`, init as RequestInit) as unknown as Response;
}

/** DNS resolver returning a single public address (SSRF passes). */
const PUBLIC_RESOLVER = async (): Promise<LookupAddress[]> => [
  { address: "8.8.8.8", family: 4 },
];

/** DNS resolver returning a private address (SSRF fails → disable). */
const PRIVATE_RESOLVER = async (): Promise<LookupAddress[]> => [
  { address: "127.0.0.1", family: 4 },
];

describe("webhook dispatcher (WP-2.5)", () => {
  let db: TestDb;
  let pool: Pool;
  let tenantCtx: TenantCtx;
  let mock: MockEndpoint;

  beforeAll(async () => {
    process.env.MSB_SECRET_ENCRYPTION_KEY = TEST_KEY;
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
    const tenant = await createTenant(pool, { name: "Dispatcher Tenant" });
    tenantCtx = { tenantId: tenant.id };
    mock = await startMockEndpoint();
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((r) => mock.server.close(() => r()));
    await closePool(pool);
    await db.container.stop();
  });

  /** Register a webhook whose URL hostname resolves via the injected resolver. */
  async function registerWebhook(eventTypes: string[]): Promise<{
    id: string;
    secret: string;
  }> {
    const created = await createWebhook(pool, tenantCtx, {
      url: "https://public.example.com/hook",
      eventTypes,
    });
    return { id: created.id, secret: created.signingSecret };
  }

  /** Count delivery rows for a webhook + event id. */
  async function deliveryFor(eventId: string): Promise<{
    rows: { event_id: string; status: string; attempt: number; last_response_code: number | null }[];
  }> {
    const { rows } = await query<{
      event_id: string;
      status: string;
      attempt: number;
      last_response_code: number | null;
    }>(
      pool,
      `SELECT event_id, status, attempt, last_response_code
         FROM webhook_deliveries
        WHERE tenant_id = $1 AND event_id = $2`,
      [tenantCtx.tenantId, eventId],
    );
    return { rows };
  }

  // -------------------------------------------------------------------------

  it("retry-idempotency: same event.id across retries; 2xx ack stops retries", async () => {
    const { id: webhookId, secret } = await registerWebhook(["session.status_idle"]);
    const dispatcher = new WebhookDispatcher({
      pool,
      fetchImpl: mockFetch(mock),
      dnsResolver: PUBLIC_RESOLVER,
      backoff: () => 0, // retry immediately
    });
    const eventId = newId("evt_");

    // First attempt: endpoint returns 500 → retry scheduled.
    mock.behavior.status = 500;
    await dispatcher.enqueueForTenant(tenantCtx.tenantId, {
      type: "session.status_idle",
      id: eventId,
      createdAt: new Date().toISOString(),
    });
    await dispatcher.tick();
    let { rows } = await deliveryFor(eventId);
    expect(rows.length).toBe(1); // one row, reused across retries (same event.id)
    expect(rows[0].status).toBe("pending");
    expect(rows[0].attempt).toBe(2); // retried once
    expect(rows[0].last_response_code).toBe(500);

    // Second attempt: endpoint now returns 200 → succeeded, retries stop.
    mock.behavior.status = 200;
    await dispatcher.tick();
    ({ rows } = await deliveryFor(eventId));
    expect(rows.length).toBe(1); // still the same single row
    expect(rows[0].status).toBe("succeeded");
    expect(rows[0].last_response_code).toBe(200);

    // Re-dispatching the same event.id does NOT create a new row (succeeded skip).
    await dispatcher.enqueueForTenant(tenantCtx.tenantId, {
      type: "session.status_idle",
      id: eventId,
      createdAt: new Date().toISOString(),
    });
    ({ rows } = await deliveryFor(eventId));
    expect(rows.length).toBe(1);

    // The delivered payload carried a verifiable signature over its thin body.
    expect(mock.received.length).toBeGreaterThanOrEqual(1);
    const last = mock.received[mock.received.length - 1];
    const parsed = JSON.parse(last.body);
    expect(parsed.id).toBe(eventId);
    expect(parsed.type).toBe("session.status_idle");
    expect(verifySignature(last.body, last.signature, secret).ok).toBe(true);

    await query(pool, "DELETE FROM webhook_deliveries WHERE webhook_id = $1", [webhookId]);
  });

  it("multi-node: two dispatchers on one pool deliver a claimed row exactly once", async () => {
    // Own tenant so fanout matches exactly one active webhook (other tests leave
    // active webhooks under the shared tenant subscribed to the same event type).
    const nodeTenant = await createTenant(pool, { name: "Multi-node Tenant" });
    const nodeCtx: TenantCtx = { tenantId: nodeTenant.id };
    const created = await createWebhook(pool, nodeCtx, {
      url: "https://public.example.com/hook",
      eventTypes: ["session.status_idle"],
    });

    // fetchImpl that sleeps so the two ticks overlap, then acks 200. Counts POSTs.
    let posts = 0;
    const slowFetch: typeof fetch = async () => {
      posts += 1;
      await new Promise((r) => setTimeout(r, 50));
      return new Response(null, { status: 200 });
    };
    const opts = { pool, fetchImpl: slowFetch, dnsResolver: PUBLIC_RESOLVER };
    const nodeA = new WebhookDispatcher(opts);
    const nodeB = new WebhookDispatcher(opts);

    const eventId = newId("evt_");
    const event = {
      type: "session.status_idle",
      id: eventId,
      createdAt: new Date().toISOString(),
    };
    await nodeA.enqueueForTenant(nodeCtx.tenantId, event);
    // Duplicate enqueue → still one row (ON CONFLICT dedup, real not check-then-act).
    await nodeB.enqueueForTenant(nodeCtx.tenantId, event);

    const rowsFor = async () =>
      (
        await query<{ status: string }>(
          pool,
          `SELECT status FROM webhook_deliveries WHERE tenant_id = $1 AND webhook_id = $2`,
          [nodeCtx.tenantId, created.id],
        )
      ).rows;
    expect((await rowsFor()).length).toBe(1);

    // Both nodes tick concurrently: the transactional claim+flip means only one
    // claims the row; the other's status='pending' claim skips the delivering row.
    await Promise.all([nodeA.tick(), nodeB.tick()]);

    expect(posts).toBe(1); // exactly ONE POST — no double-delivery
    const rows = await rowsFor();
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("succeeded");

    await query(pool, "DELETE FROM webhook_deliveries WHERE webhook_id = $1", [created.id]);
  });

  it("auto-disable: private-IP resolution disables immediately", async () => {
    const { id: webhookId } = await registerWebhook(["session.status_idle"]);
    const dispatcher = new WebhookDispatcher({
      pool,
      fetchImpl: mockFetch(mock),
      dnsResolver: PRIVATE_RESOLVER, // endpoint resolves to 127.0.0.1
    });
    const eventId = newId("evt_");
    await dispatcher.enqueueForTenant(tenantCtx.tenantId, {
      type: "session.status_idle",
      id: eventId,
      createdAt: new Date().toISOString(),
    });
    await dispatcher.tick();

    const wh = await getWebhook(pool, tenantCtx, webhookId);
    expect(wh!.status).toBe("disabled");
    expect(wh!.disabledReason).toContain("ssrf-private-ip");

    const { rows } = await deliveryFor(eventId);
    expect(rows[0].status).toBe("failed");

    await query(pool, "DELETE FROM webhook_deliveries WHERE webhook_id = $1", [webhookId]);
  });

  it("auto-disable: a 3xx redirect disables immediately (redirects not followed)", async () => {
    const { id: webhookId } = await registerWebhook(["session.status_idle"]);
    const dispatcher = new WebhookDispatcher({
      pool,
      fetchImpl: mockFetch(mock),
      dnsResolver: PUBLIC_RESOLVER,
    });
    const eventId = newId("evt_");
    mock.behavior.status = 302;
    mock.behavior.location = "https://attacker.example.com/leak";
    await dispatcher.enqueueForTenant(tenantCtx.tenantId, {
      type: "session.status_idle",
      id: eventId,
      createdAt: new Date().toISOString(),
    });
    await dispatcher.tick();

    const wh = await getWebhook(pool, tenantCtx, webhookId);
    expect(wh!.status).toBe("disabled");
    expect(wh!.disabledReason).toContain("redirect");

    const { rows } = await deliveryFor(eventId);
    expect(rows[0].status).toBe("failed");
    // (redirect status is unreadable under `redirect: "manual"`; the opaqueredirect
    // type triggers the disable.)

    await query(pool, "DELETE FROM webhook_deliveries WHERE webhook_id = $1", [webhookId]);
  });

  it("ROB-19: an unexpected delivery error schedules a retry, not a terminal failure", async () => {
    const { id: webhookId } = await registerWebhook(["session.status_idle"]);
    const dispatcher = new WebhookDispatcher({
      pool,
      fetchImpl: mockFetch(mock),
      dnsResolver: PUBLIC_RESOLVER,
      backoff: () => 60_000,
    });
    // Simulate an unexpected (non-HTTP, non-SSRF) error escaping deliverOne — e.g.
    // a DB/pool failure. deliverOne handles HTTP/SSRF outcomes itself, so only such
    // errors reach the batch catch. ROB-19: these must retry, not mark failed.
    (dispatcher as unknown as { deliverOne: () => Promise<void> }).deliverOne = () => {
      throw new Error("simulated pool failure");
    };
    const eventId = newId("evt_");
    await dispatcher.enqueueForTenant(tenantCtx.tenantId, {
      type: "session.status_idle",
      id: eventId,
      createdAt: new Date().toISOString(),
    });
    await dispatcher.tick();

    const { rows } = await deliveryFor(eventId);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("pending"); // retried (scheduleRetry), not 'failed'
    expect(rows[0].attempt).toBe(2);

    await query(pool, "DELETE FROM webhook_deliveries WHERE webhook_id = $1", [webhookId]);
  });

  it("ROB-1: an overlapping tick does not stack over a running one (in-flight guard)", async () => {
    const dispatcher = new WebhookDispatcher({
      pool,
      fetchImpl: mockFetch(mock),
      dnsResolver: PUBLIC_RESOLVER,
    });
    let claimCalls = 0;
    (dispatcher as unknown as { claimDue: () => Promise<unknown[]> }).claimDue = async () => {
      claimCalls++;
      await new Promise((r) => setTimeout(r, 50));
      return [];
    };
    // First tick sets inFlight before awaiting; the second must short-circuit.
    await Promise.all([dispatcher.tick(), dispatcher.tick()]);
    expect(claimCalls).toBe(1);
  });

  it("auto-disable: ~20 consecutive failures disable the webhook", async () => {
    const { id: webhookId } = await registerWebhook(["session.status_idle"]);
    const dispatcher = new WebhookDispatcher({
      pool,
      fetchImpl: mockFetch(mock),
      dnsResolver: PUBLIC_RESOLVER,
      backoff: () => 0, // retry immediately
      maxAttempts: 20,
    });
    const eventId = newId("evt_");
    mock.behavior.status = 500;
    await dispatcher.enqueueForTenant(tenantCtx.tenantId, {
      type: "session.status_idle",
      id: eventId,
      createdAt: new Date().toISOString(),
    });

    // Drive the retry loop until the webhook is disabled (or cap iterations).
    let disabled = false;
    for (let i = 0; i < 30 && !disabled; i++) {
      await dispatcher.tick();
      const wh = await getWebhook(pool, tenantCtx, webhookId);
      if (wh!.status === "disabled") disabled = true;
    }
    expect(disabled).toBe(true);

    const wh = await getWebhook(pool, tenantCtx, webhookId);
    expect(wh!.disabledReason).toContain("consecutive-failures");

    // Scope to THIS webhook: a unique event fans out one delivery row per subscribed
    // webhook, and sibling tests leave their own `session.status_idle` webhooks behind.
    // The invariant under test is that retries of the same event.id never multiply rows
    // for a given webhook.
    const { rows } = await query<{ status: string; attempt: number }>(
      pool,
      `SELECT status, attempt FROM webhook_deliveries
        WHERE webhook_id = $1 AND event_id = $2`,
      [webhookId, eventId],
    );
    expect(rows.length).toBe(1); // one row for this webhook across all retries
    expect(rows[0].status).toBe("failed");
    expect(rows[0].attempt).toBeGreaterThanOrEqual(19);

    await query(pool, "DELETE FROM webhook_deliveries WHERE webhook_id = $1", [webhookId]);
  });
});
