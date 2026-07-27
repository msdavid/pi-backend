/**
 * Ledger integration (console spec §11.3, WP-C5.1) — real Postgres testcontainer.
 *
 * Drives the production {@link appendEntry} / balance / lifecycle against a real
 * DB (RLS, constraints, row locking all live) and pins THE money invariant:
 * replaying an idempotency key credits the ledger EXACTLY once. Also covers
 * concurrent credits/debits not racing the balance, lifecycle crossings, and
 * cross-tenant isolation.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPool,
  closePool,
  query,
  runMigrations,
  type Pool,
} from "../../../infra/db/index.js";
import { startPostgres, type TestDb } from "../../../infra/db/__tests__/test-runtime.js";
import { createTenant } from "../../tenant/tenant.js";
import {
  appendEntry,
  getBillingRow,
  getBillingState,
  listLedgerEntries,
} from "../ledger.js";

describe("ledger (integration)", () => {
  let db: TestDb;
  let pool: Pool;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  async function freshTenant(): Promise<string> {
    const t = await createTenant(pool, { name: `Ledger ${Math.random()}` });
    return t.id;
  }

  it("replaying a credit key credits the balance exactly once (THE money invariant)", async () => {
    const tenantId = await freshTenant();
    const key = "topup-abc";

    const first = await appendEntry(pool, {
      tenantId,
      kind: "topup",
      amountMicros: 5_000_000,
      idempotencyKey: key,
      source: "test",
    });
    expect(first.applied).toBe(true);
    expect(first.balanceMicros).toBe(5_000_000);

    // Replay the SAME key: returns the existing entry, no second credit.
    const replay = await appendEntry(pool, {
      tenantId,
      kind: "topup",
      amountMicros: 5_000_000,
      idempotencyKey: key,
      source: "test",
    });
    expect(replay.applied).toBe(false);
    expect(replay.entry.id).toBe(first.entry.id);
    expect(replay.balanceMicros).toBe(5_000_000);

    const row = await getBillingRow(pool, tenantId);
    expect(row?.balanceMicros).toBe(5_000_000);
    // Exactly one entry exists for the key.
    const { rows } = await query<{ count: string }>(
      pool,
      "SELECT count(*)::text AS count FROM ledger_entries WHERE tenant_id = $1 AND idempotency_key = $2",
      [tenantId, key],
    );
    expect(rows[0].count).toBe("1");
  });

  it("concurrent distinct debits/credits sum without racing the balance", async () => {
    const tenantId = await freshTenant();
    await appendEntry(pool, {
      tenantId,
      kind: "topup",
      amountMicros: 1_000_000,
      idempotencyKey: "seed",
    });

    // 20 concurrent credits of +100 and 20 debits of -100 (distinct keys) net 0.
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      ops.push(
        appendEntry(pool, { tenantId, kind: "topup", amountMicros: 100, idempotencyKey: `c${i}` }),
      );
      ops.push(
        appendEntry(pool, { tenantId, kind: "debit", amountMicros: -100, idempotencyKey: `d${i}` }),
      );
    }
    await Promise.all(ops);

    const row = await getBillingRow(pool, tenantId);
    expect(row?.balanceMicros).toBe(1_000_000);
    // 41 entries: seed + 40 ops, each recorded exactly once.
    //
    // We deliberately do NOT assert that the last entry's balance_after equals the
    // balance: nothing here can identify the last-APPLIED entry. `created_at` defaults
    // to `now()`, which is transaction-START time in Postgres, so it does not track the
    // order in which concurrent transactions take the `FOR UPDATE` lock, and `id` is
    // random. The authoritative no-lost-update guarantee is `balanceMicros` above.
    const { rows } = await query<{ count: string }>(
      pool,
      "SELECT count(*)::text AS count FROM ledger_entries WHERE tenant_id = $1",
      [tenantId],
    );
    expect(rows[0].count).toBe("41");
  });

  it("concurrent replays of the SAME key apply exactly once", async () => {
    const tenantId = await freshTenant();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        appendEntry(pool, {
          tenantId,
          kind: "topup",
          amountMicros: 250_000,
          idempotencyKey: "race-key",
        }),
      ),
    );
    const applied = results.filter((r) => r.applied);
    expect(applied).toHaveLength(1);
    const row = await getBillingRow(pool, tenantId);
    expect(row?.balanceMicros).toBe(250_000);
  });

  it("lifecycle crosses active↔suspended as the balance crosses 0", async () => {
    const tenantId = await freshTenant();
    const up = await appendEntry(pool, {
      tenantId,
      kind: "topup",
      amountMicros: 400_000,
      idempotencyKey: "up",
    });
    expect(up.lifecycle).toBe("active");

    const down = await appendEntry(pool, {
      tenantId,
      kind: "debit",
      amountMicros: -400_000,
      idempotencyKey: "down",
    });
    expect(down.balanceMicros).toBe(0);
    expect(down.lifecycle).toBe("suspended");

    const back = await appendEntry(pool, {
      tenantId,
      kind: "topup",
      amountMicros: 10_000,
      idempotencyKey: "back",
    });
    expect(back.lifecycle).toBe("active");
  });

  it("isolates ledgers by tenant (same idempotency key, distinct tenants)", async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    await appendEntry(pool, { tenantId: a, kind: "topup", amountMicros: 111, idempotencyKey: "shared" });
    await appendEntry(pool, { tenantId: b, kind: "topup", amountMicros: 222, idempotencyKey: "shared" });

    expect((await getBillingRow(pool, a))?.balanceMicros).toBe(111);
    expect((await getBillingRow(pool, b))?.balanceMicros).toBe(222);

    const aEntries = await listLedgerEntries(pool, { tenantId: a, scopes: ["read"] }, 50);
    expect(aEntries).toHaveLength(1);
    expect(aEntries[0].amountMicros).toBe(111);

    const state = await getBillingState(pool, a);
    expect(state?.balanceUsd).toBeCloseTo(111 / 1_000_000);
  });
});
