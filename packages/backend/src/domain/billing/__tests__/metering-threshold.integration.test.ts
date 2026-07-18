/**
 * Balance-threshold events integration (console spec §11.6, WP-C5.2) — real Postgres
 * + the REAL webhook dispatch path.
 *
 * Drives ledger debits through {@link appendEntryWithThresholdEvents} (the seam the
 * metering aggregator uses) and asserts that `tenant.balance_low` /
 * `tenant.balance_exhausted` fire EXACTLY once per crossing, never on a debit already
 * below the line, are isolated per tenant, respect the configured threshold, and are
 * actually delivered (HMAC-signed) with a schema-valid {@link TenantBalanceEventData}
 * payload — through the same {@link WebhookDispatcher} enqueue+deliver path production
 * uses.
 */

import http from "node:http";
import { type AddressInfo } from "node:net";
import type { LookupAddress } from "node:dns";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantBalanceEventData } from "@pi-managed/contracts";
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
import { createWebhook } from "../../webhook/webhook.js";
import { WebhookDispatcher, createWebhookEventSource } from "../../webhook/index.js";
import type { WebhookEventSource } from "../../webhook/event-source.js";
import { verify as verifySignature } from "../../webhook/signature.js";
import { appendEntry } from "../ledger.js";
import { appendEntryWithThresholdEvents } from "../threshold.js";

const TEST_KEY = "0".repeat(64);
const THRESHOLD = 2_000_000; // $2 low threshold.

interface Mock {
  url: string;
  server: http.Server;
  received: { body: string; signature: string }[];
}

async function startMock(): Promise<Mock> {
  const received: { body: string; signature: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c.toString()));
    req.on("end", () => {
      received.push({ body, signature: req.headers["x-webhook-signature"] as string });
      res.writeHead(200);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, server, received };
}

const PUBLIC_RESOLVER = async (): Promise<LookupAddress[]> => [{ address: "8.8.8.8", family: 4 }];

interface DeliveryRow {
  event_type: string;
  payload: {
    type: string;
    data?: { balanceMicros: number; thresholdMicros: number; entryId?: string };
  };
}

describe("balance-threshold events (integration, §11.6)", () => {
  let db: TestDb;
  let pool: Pool;
  let mock: Mock;
  let dispatcher: WebhookDispatcher;
  let eventSource: ReturnType<typeof createWebhookEventSource>;

  beforeAll(async () => {
    process.env.MSB_SECRET_ENCRYPTION_KEY = TEST_KEY;
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
    mock = await startMock();
    dispatcher = new WebhookDispatcher({
      pool,
      fetchImpl: (async (_i, init) => fetch(`${mock.url}/hook`, init as RequestInit)) as unknown as typeof fetch,
      dnsResolver: PUBLIC_RESOLVER,
      backoff: () => 0,
    });
    eventSource = createWebhookEventSource(dispatcher);
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((r) => mock.server.close(() => r()));
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  async function freshTenant(name: string): Promise<TenantCtx> {
    const t = await createTenant(pool, { name: `${name} ${Math.random()}` });
    return { tenantId: t.id };
  }

  /** Register a webhook subscribed to the two threshold events. */
  async function subscribe(ctx: TenantCtx): Promise<string> {
    const created = await createWebhook(pool, ctx, {
      url: "https://public.example.com/hook",
      eventTypes: ["tenant.balance_low", "tenant.balance_exhausted"],
    });
    return created.id;
  }

  /** Enqueued delivery rows for a webhook, oldest first. */
  async function deliveriesFor(webhookId: string): Promise<DeliveryRow[]> {
    const { rows } = await query<DeliveryRow>(
      pool,
      `SELECT event_type, payload FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY created_at ASC`,
      [webhookId],
    );
    return rows;
  }

  async function debit(ctx: TenantCtx, amount: number, key: string) {
    return appendEntryWithThresholdEvents(
      pool,
      eventSource,
      { tenantId: ctx.tenantId, kind: "debit", amountMicros: -amount, idempotencyKey: key },
      THRESHOLD,
    );
  }

  it("fires balance_low then balance_exhausted exactly once per crossing, none in between", async () => {
    const a = await freshTenant("A");
    const whA = await subscribe(a);
    await appendEntry(pool, { tenantId: a.tenantId, kind: "topup", amountMicros: 3_000_000, idempotencyKey: "seed" });

    // 3.0 → 1.5 : crosses the $2 low line (still > 0) ⇒ balance_low.
    await debit(a, 1_500_000, "d1");
    // 1.5 → 1.0 : already below the low line, still > 0 ⇒ NOTHING.
    await debit(a, 500_000, "d2");
    // 1.0 → 0 : crosses 0 ⇒ balance_exhausted.
    await debit(a, 1_000_000, "d3");

    const rows = await deliveriesFor(whA);
    expect(rows.map((r) => r.event_type)).toEqual([
      "tenant.balance_low",
      "tenant.balance_exhausted",
    ]);
    // The `data` payload carries the AT-CROSSING balance + threshold and validates.
    const low = rows[0].payload;
    const exhausted = rows[1].payload;
    expect(() => TenantBalanceEventData.parse(low.data)).not.toThrow();
    expect(() => TenantBalanceEventData.parse(exhausted.data)).not.toThrow();
    expect(low.data?.balanceMicros).toBe(1_500_000);
    expect(low.data?.thresholdMicros).toBe(THRESHOLD);
    expect(exhausted.data?.balanceMicros).toBe(0);
  });

  it("a replayed debit key emits no second event (crossing fires once)", async () => {
    const t = await freshTenant("replay");
    const wh = await subscribe(t);
    await appendEntry(pool, { tenantId: t.tenantId, kind: "topup", amountMicros: 3_000_000, idempotencyKey: "seed" });
    await debit(t, 1_500_000, "cross"); // fires balance_low
    await debit(t, 1_500_000, "cross"); // replay ⇒ applied:false ⇒ no event
    const rows = await deliveriesFor(wh);
    expect(rows.map((r) => r.event_type)).toEqual(["tenant.balance_low"]);
  });

  it("re-emits a crossing whose first emit threw, exactly once (F1 — never lost)", async () => {
    const t = await freshTenant("flaky-emit");
    const wh = await subscribe(t);
    await appendEntry(pool, { tenantId: t.tenantId, kind: "topup", amountMicros: 3_000_000, idempotencyKey: "seed" });

    // First flush: the debit COMMITS but the emit throws once. The old behavior left
    // the crossing permanently unemitted (the retry's replay short-circuited).
    let failNext = true;
    const flaky: WebhookEventSource = {
      async emit(tenantId, type, id, createdAt, data) {
        if (failNext) {
          failNext = false;
          throw new Error("emit boom");
        }
        return eventSource.emit(tenantId, type, id, createdAt, data);
      },
    };
    await expect(
      appendEntryWithThresholdEvents(
        pool,
        flaky,
        { tenantId: t.tenantId, kind: "debit", amountMicros: -1_500_000, idempotencyKey: "cross" },
        THRESHOLD,
      ),
    ).rejects.toThrow("emit boom");
    // Debit committed, but the crossing is NOT yet enqueued (emit failed).
    expect(await deliveriesFor(wh)).toHaveLength(0);

    // Metering keeps the bucket and retries the SAME key: append is now a no-op replay,
    // yet the crossing must still be emitted — exactly once.
    await debit(t, 1_500_000, "cross");
    expect((await deliveriesFor(wh)).map((r) => r.event_type)).toEqual(["tenant.balance_low"]);

    // A further re-flush (same key again) does NOT double-emit: the stable, entry-derived
    // event id dedups the delivery.
    await debit(t, 1_500_000, "cross");
    const rows = await deliveriesFor(wh);
    expect(rows.map((r) => r.event_type)).toEqual(["tenant.balance_low"]);
    // The payload carries the STABLE crossing id (entryId) auto-charge keys on (F2).
    expect(rows[0].payload.data?.entryId).toMatch(/^led_/);
  });

  it("a debit that stays above the threshold fires nothing", async () => {
    const t = await freshTenant("above");
    const wh = await subscribe(t);
    await appendEntry(pool, { tenantId: t.tenantId, kind: "topup", amountMicros: 3_000_000, idempotencyKey: "seed" });
    await debit(t, 400_000, "small"); // 3.0 → 2.6, still > $2
    expect(await deliveriesFor(wh)).toHaveLength(0);
  });

  it("isolates threshold events per tenant (a crossing enqueues only to that tenant's webhook)", async () => {
    const a = await freshTenant("iso-A");
    const b = await freshTenant("iso-B");
    const whA = await subscribe(a);
    const whB = await subscribe(b);
    await appendEntry(pool, { tenantId: a.tenantId, kind: "topup", amountMicros: 3_000_000, idempotencyKey: "seed" });
    await appendEntry(pool, { tenantId: b.tenantId, kind: "topup", amountMicros: 3_000_000, idempotencyKey: "seed" });

    await debit(a, 1_500_000, "d1"); // A crosses low only.
    await debit(b, 1_500_000, "d1"); // B crosses low (3.0 → 1.5)…
    await debit(b, 1_500_000, "d2"); // …then exhausted (1.5 → 0).

    const aRows = await deliveriesFor(whA);
    const bRows = await deliveriesFor(whB);
    expect(aRows.map((r) => r.event_type)).toEqual(["tenant.balance_low"]);
    expect(bRows.map((r) => r.event_type)).toEqual([
      "tenant.balance_low",
      "tenant.balance_exhausted",
    ]);
    // A's webhook never saw B's tenant, and vice-versa.
    for (const r of aRows) expect(r.payload.data?.balanceMicros).toBe(1_500_000);
  });

  it("delivers the events HMAC-signed through the real dispatch path", async () => {
    const t = await freshTenant("deliver");
    const created = await createWebhook(pool, t, {
      url: "https://public.example.com/hook",
      eventTypes: ["tenant.balance_low"],
    });
    await appendEntry(pool, { tenantId: t.tenantId, kind: "topup", amountMicros: 3_000_000, idempotencyKey: "seed" });

    const before = mock.received.length;
    await debit(t, 1_500_000, "d1"); // enqueues balance_low
    await dispatcher.tick(); // real deliver (drains all pending across the shared DB)

    // Isolate THIS tenant's delivery among any other pending ones the tick drained.
    const mine = mock.received.slice(before).filter((r) => {
      const p = JSON.parse(r.body) as { data?: { tenantId?: string } };
      return p.data?.tenantId === t.tenantId;
    });
    expect(mine).toHaveLength(1);
    const payload = JSON.parse(mine[0].body) as { type: string; data: unknown };
    expect(payload.type).toBe("tenant.balance_low");
    expect(() => TenantBalanceEventData.parse(payload.data)).not.toThrow();
    // Signed with the webhook's secret (the real dispatch path, §23.4).
    expect(verifySignature(mine[0].body, mine[0].signature, created.signingSecret).ok).toBe(true);
  });
});
