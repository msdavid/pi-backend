/**
 * The ledger — source of truth for tenant balance (console spec §11.3, WP-C5.1).
 *
 * Prepaid, single-unit (dollars, stored as integer micro-dollars — see
 * {@link MICROS_PER_USD}). Every balance movement (grant / topup / debit /
 * adjustment) is an append-only {@link LedgerEntry} carrying an idempotency key.
 * Balance is a MATERIALIZED column on `tenant_billing`, kept transactionally in
 * step with the entry insert so the enforcement hot path (§11.1) is a single-row
 * read rather than a growing SUM.
 *
 * **THE money invariant (idempotency).** {@link appendEntry} runs in one
 * transaction that locks the tenant's `tenant_billing` row `FOR UPDATE`, inserts
 * the entry `ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`, and only moves
 * the balance when a row was actually inserted. Replaying an idempotency key
 * therefore returns the EXISTING entry and never double-credits; the row lock
 * serializes concurrent credits/debits so the balance can never race negative or
 * double-apply.
 *
 * This is a SYSTEM surface (the machine credit-surface and the verification flow
 * call it without a tenant context), so it uses the raw pool — RLS (migration
 * 042) is permissive when `app.current_tenant` is unset, matching onboarding
 * sign-up. Tenant-scoped console reads go through {@link tenantScopedQuery}.
 */

import type {
  LedgerEntryKind,
  LedgerEntry,
  BillingLifecycle,
  TenantBillingState,
} from "@pi-managed/contracts";
import { MICROS_PER_USD } from "@pi-managed/contracts";
import { query, type Pool } from "../../infra/db/index.js";
import type { TenantCtx } from "../../infra/db/index.js";
import { tenantScopedQuery } from "../../infra/db/tenant-scoped.js";
import { newId } from "../tenant/ids.js";

/** Convert integer micro-dollars to a USD number (server-side; §11.9). */
export function microsToUsd(micros: number): number {
  return micros / MICROS_PER_USD;
}

/** A `tenant_billing` row (camelCased). */
export interface TenantBillingRow {
  tenantId: string;
  lifecycle: BillingLifecycle;
  balanceMicros: number;
  verificationTokenHash: string | null;
  verificationExpiresAt: Date | null;
  verifiedAt: Date | null;
  pendingGrantMicros: number;
}

/** Input to {@link appendEntry}. `amountMicros` is SIGNED (credits +, debits −). */
export interface AppendEntryInput {
  tenantId: string;
  kind: LedgerEntryKind;
  amountMicros: number;
  /** Idempotency key, unique per tenant — a replay returns the existing entry. */
  idempotencyKey: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

/** Result of {@link appendEntry}: the entry plus whether it was newly applied. */
export interface AppendEntryResult {
  entry: LedgerEntry;
  /** `false` on an idempotent replay (the key already existed; balance untouched). */
  applied: boolean;
  /** The tenant's lifecycle after this call (unchanged on a replay). */
  lifecycle: BillingLifecycle;
  /** The tenant's balance (micros) after this call (unchanged on a replay). */
  balanceMicros: number;
}

/** Thrown when `amountMicros` sign is inconsistent with `kind` (a programmer error). */
export class LedgerAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerAmountError";
  }
}

function assertAmountSign(kind: LedgerEntryKind, amountMicros: number): void {
  if (!Number.isInteger(amountMicros) || amountMicros === 0) {
    throw new LedgerAmountError(`amountMicros must be a non-zero integer, got ${amountMicros}`);
  }
  if ((kind === "grant" || kind === "topup") && amountMicros <= 0) {
    throw new LedgerAmountError(`${kind} amount must be positive, got ${amountMicros}`);
  }
  if (kind === "debit" && amountMicros >= 0) {
    throw new LedgerAmountError(`debit amount must be negative, got ${amountMicros}`);
  }
}

/**
 * Compute the lifecycle after a balance move. `active ↔ suspended` as the balance
 * crosses 0 (§11.1); a `trial`/`suspended` tenant whose balance turns positive
 * becomes `active` (the trial grant activates the tenant; a top-up un-suspends).
 * A `trial` tenant at ≤ 0 stays `trial` (still the pre-verification gate).
 */
function nextLifecycle(current: BillingLifecycle, newBalanceMicros: number): BillingLifecycle {
  // Positive balance ⇒ active (a trial grant activates the tenant; a top-up
  // un-suspends). ≤ 0 ⇒ suspended, EXCEPT a trial at ≤ 0 stays `trial` (still the
  // pre-verification gate, not a suspension).
  if (newBalanceMicros > 0) return "active";
  return current === "trial" ? "trial" : "suspended";
}

const SELECT_BILLING_COLS = `
  tenant_id AS "tenantId",
  lifecycle,
  balance_micros AS "balanceMicros",
  verification_token_hash AS "verificationTokenHash",
  verification_expires_at AS "verificationExpiresAt",
  verified_at AS "verifiedAt",
  pending_grant_micros AS "pendingGrantMicros"`;

/** Read a tenant's billing row, or `null` if the tenant is not enrolled in the ledger. */
export async function getBillingRow(
  pool: Pool,
  tenantId: string,
): Promise<TenantBillingRow | null> {
  const { rows } = await query<TenantBillingRow>(
    pool,
    `SELECT ${SELECT_BILLING_COLS} FROM tenant_billing WHERE tenant_id = $1`,
    [tenantId],
  );
  const row = rows[0];
  if (!row) return null;
  return { ...row, balanceMicros: Number(row.balanceMicros), pendingGrantMicros: Number(row.pendingGrantMicros) };
}

/**
 * Create a tenant's `tenant_billing` row if absent (lifecycle `trial`, balance 0).
 * Idempotent (`ON CONFLICT DO NOTHING`). Used by trial provisioning and by
 * {@link appendEntry} so a credit to an un-enrolled tenant still lands.
 */
export async function ensureBillingRow(pool: Pool, tenantId: string): Promise<void> {
  await query(
    pool,
    `INSERT INTO tenant_billing (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId],
  );
}

function rowToEntry(row: {
  id: string;
  kind: LedgerEntryKind;
  amount_micros: string | number;
  balance_after_micros: string | number;
  source: string | null;
  created_at: Date;
}): LedgerEntry {
  const amountMicros = Number(row.amount_micros);
  const balanceAfterMicros = Number(row.balance_after_micros);
  return {
    id: row.id,
    kind: row.kind,
    amountMicros,
    amountUsd: microsToUsd(amountMicros),
    balanceAfterMicros,
    balanceAfterUsd: microsToUsd(balanceAfterMicros),
    source: row.source,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Map a billing row to the wire {@link TenantBillingState} (money divided
 * server-side, §11.9). Returns `null` when the tenant is not enrolled in the
 * ledger (no `tenant_billing` row).
 */
export async function getBillingState(
  pool: Pool,
  tenantId: string,
): Promise<TenantBillingState | null> {
  const row = await getBillingRow(pool, tenantId);
  if (!row) return null;
  const verified = row.verifiedAt !== null;
  return {
    lifecycle: row.lifecycle,
    balanceMicros: row.balanceMicros,
    balanceUsd: microsToUsd(row.balanceMicros),
    verified,
    // Unverified trial ⇒ still needs verification to gain an active balance.
    verificationRequired: !verified && row.lifecycle === "trial",
  };
}

/** A keyset cursor position for ledger history (created_at DESC, id DESC). */
export interface LedgerCursor {
  createdAt: string;
  id: string;
}

/**
 * Tenant-scoped ledger history, newest first (console spec §11.8). Reads through
 * {@link tenantScopedQuery} so RLS pins the rows to the caller's tenant. Fetches
 * up to `limit` entries strictly older than `before` (keyset pagination).
 */
export async function listLedgerEntries(
  pool: Pool,
  ctx: TenantCtx,
  limit: number,
  before?: LedgerCursor,
): Promise<LedgerEntry[]> {
  const params: unknown[] = [ctx.tenantId];
  let where = "tenant_id = $1";
  if (before) {
    where += " AND (created_at, id) < ($2, $3)";
    params.push(new Date(before.createdAt), before.id);
  }
  params.push(limit);
  const { rows } = await tenantScopedQuery<{
    id: string;
    kind: LedgerEntryKind;
    amount_micros: string;
    balance_after_micros: string;
    source: string | null;
    created_at: Date;
  }>(
    pool,
    ctx,
    `SELECT id, kind, amount_micros, balance_after_micros, source, created_at
       FROM ledger_entries
      WHERE ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map(rowToEntry);
}

/**
 * Append a ledger entry idempotently and move the materialized balance in the
 * same transaction (THE money invariant — see the file header). Optionally forces
 * a lifecycle (used by verification to activate a trial); otherwise the lifecycle
 * follows {@link nextLifecycle}.
 *
 * On a replay (idempotency key already present for the tenant) the existing entry
 * is returned with `applied: false` and NO balance change.
 */
export async function appendEntry(
  pool: Pool,
  input: AppendEntryInput,
  opts: { forceLifecycle?: BillingLifecycle } = {},
): Promise<AppendEntryResult> {
  assertAmountSign(input.kind, input.amountMicros);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock the tenant's billing row (create it first if absent) so concurrent
    // credits/debits serialize on it. `ensureBillingRow` before the lock avoids a
    // FOR UPDATE on a non-existent row.
    await client.query(
      `INSERT INTO tenant_billing (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`,
      [input.tenantId],
    );
    const locked = await client.query<{ balance_micros: string; lifecycle: BillingLifecycle }>(
      `SELECT balance_micros, lifecycle FROM tenant_billing WHERE tenant_id = $1 FOR UPDATE`,
      [input.tenantId],
    );
    const currentBalance = Number(locked.rows[0].balance_micros);
    const currentLifecycle = locked.rows[0].lifecycle;
    const newBalance = currentBalance + input.amountMicros;

    const id = newId("led_");
    const inserted = await client.query<{
      id: string;
      kind: LedgerEntryKind;
      amount_micros: string;
      balance_after_micros: string;
      source: string | null;
      created_at: Date;
    }>(
      `INSERT INTO ledger_entries
         (id, tenant_id, kind, amount_micros, balance_after_micros, idempotency_key, source, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING id, kind, amount_micros, balance_after_micros, source, created_at`,
      [
        id,
        input.tenantId,
        input.kind,
        input.amountMicros,
        newBalance,
        input.idempotencyKey,
        input.source ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
      ],
    );

    if (inserted.rows.length === 0) {
      // Replay: the key already exists for this tenant. Return the existing entry
      // WITHOUT touching the balance (the money invariant). No lifecycle change.
      const existing = await client.query<{
        id: string;
        kind: LedgerEntryKind;
        amount_micros: string;
        balance_after_micros: string;
        source: string | null;
        created_at: Date;
      }>(
        `SELECT id, kind, amount_micros, balance_after_micros, source, created_at
           FROM ledger_entries WHERE tenant_id = $1 AND idempotency_key = $2`,
        [input.tenantId, input.idempotencyKey],
      );
      await client.query("COMMIT");
      return {
        entry: rowToEntry(existing.rows[0]),
        applied: false,
        lifecycle: currentLifecycle,
        balanceMicros: currentBalance,
      };
    }

    const lifecycle = opts.forceLifecycle ?? nextLifecycle(currentLifecycle, newBalance);
    await client.query(
      `UPDATE tenant_billing
          SET balance_micros = $2, lifecycle = $3, updated_at = now()
        WHERE tenant_id = $1`,
      [input.tenantId, newBalance, lifecycle],
    );
    await client.query("COMMIT");
    return {
      entry: rowToEntry(inserted.rows[0]),
      applied: true,
      lifecycle,
      balanceMicros: newBalance,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
