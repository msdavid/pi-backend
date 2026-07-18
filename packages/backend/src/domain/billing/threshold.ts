/**
 * Balance-threshold webhook events (console spec §11.6, WP-C5.2).
 *
 * Fires `tenant.balance_low` (configurable threshold) and `tenant.balance_exhausted`
 * when a ledger debit CROSSES the line — exactly once per crossing, never re-fired
 * on a debit already below it. The crossing is detected from the pre/post balance of
 * the causing entry (the ledger row-locks the tenant, so `pre = post − amount` is the
 * balance the previous serialized entry left — the derivation is race-free), and the
 * events are emitted AFTER the ledger transaction commits through the existing
 * {@link WebhookEventSource} (the same tenant-scoped fan-out job/session lifecycle
 * events use).
 *
 * **Emit is decoupled from append + is itself idempotent (F1).** Appending the entry
 * (idempotent by the ledger key) and emitting the crossing are separate concerns.
 * Each crossing emit carries a STABLE event id derived from the causing entry
 * ({@link crossingEventId}); the dispatcher dedups deliveries on that id. So a replay
 * (`applied: false`) — the path a metering retry takes after a debit committed but a
 * prior emit threw — still re-derives and re-emits the crossing, deduped by the stable
 * id: the crossing fires exactly once and is never silently lost, and a genuine
 * duplicate never double-fires.
 *
 * The two events carry a self-contained {@link TenantBalanceEventData} `data` payload
 * (§11.6, the exception to the thin webhook default): a consumer — the console banner,
 * email, or the auto-charge engine — gets the AT-CROSSING balance + threshold without
 * a round-trip, since the live balance keeps moving.
 */

import type {
  BillingLifecycle,
  TenantBalanceEventData,
} from "@pi-managed/contracts";
import type { Pool } from "../../infra/db/index.js";
import type { WebhookEventSource } from "../webhook/event-source.js";
import {
  appendEntry,
  microsToUsd,
  type AppendEntryInput,
  type AppendEntryResult,
} from "./ledger.js";

/** Which threshold(s) a balance move crossed (downward). */
export interface BalanceCrossings {
  /** Crossed DOWN through the low threshold while still > 0. */
  low: boolean;
  /** Crossed DOWN through 0 (exhausted). */
  exhausted: boolean;
}

/**
 * Detect which thresholds a balance move from `preMicros` to `postMicros` crossed.
 * Only a DOWNWARD move (a debit / negative adjustment) can cross: a top-up moving
 * the balance up never fires. Fires on the CROSSING boundary only — a move that was
 * already at/below a line does not re-cross it. A `thresholdMicros` of 0 disables the
 * low event (only exhaustion fires).
 */
export function detectBalanceCrossings(
  preMicros: number,
  postMicros: number,
  thresholdMicros: number,
): BalanceCrossings {
  if (postMicros >= preMicros) return { low: false, exhausted: false };
  const low =
    thresholdMicros > 0 &&
    preMicros > thresholdMicros &&
    postMicros <= thresholdMicros &&
    postMicros > 0;
  const exhausted = preMicros > 0 && postMicros <= 0;
  return { low, exhausted };
}

/** The two balance-threshold event types (a crossing fires at most one of them). */
type BalanceThresholdEventType = "tenant.balance_low" | "tenant.balance_exhausted";

/** Build the `data` payload the threshold events carry (money server-divided, §11.9). */
function balanceEventData(
  entryId: string,
  tenantId: string,
  balanceMicros: number,
  thresholdMicros: number,
  lifecycle: BillingLifecycle,
): TenantBalanceEventData {
  return {
    entryId,
    tenantId,
    balanceMicros,
    balanceUsd: microsToUsd(balanceMicros),
    thresholdMicros,
    thresholdUsd: microsToUsd(thresholdMicros),
    lifecycle,
  };
}

/**
 * Deterministic webhook event id for a balance crossing, keyed by the CAUSING ledger
 * entry (F1). The dispatcher dedups deliveries on `(webhook_id, event_id)`, so a
 * re-emit under this stable id collapses onto the same delivery row (`ON CONFLICT DO
 * NOTHING`) instead of double-firing. This is what makes the emit idempotent AND
 * retryable: a crossing whose emit failed after the debit committed is re-emitted on
 * the metering retry (below) under the same id — the crossing fires exactly once and
 * is never lost, with no separate marker table. `led_…` entry ids are unique, and a
 * single entry crosses at most one line (low XOR exhausted), so the id is unique per
 * crossing.
 */
function crossingEventId(entryId: string, type: BalanceThresholdEventType): string {
  const line = type === "tenant.balance_low" ? "low" : "exhausted";
  return `evt_balance_${line}_${entryId}`;
}

/**
 * Emit the balance-threshold webhook events for a crossing (if any) through the
 * event source, keyed to the causing ledger `entryId` (stable, replay-safe). Exposed
 * for callers that already hold the pre/post balance (and for tests);
 * {@link appendEntryWithThresholdEvents} is the usual entry point.
 */
export async function emitBalanceThresholdEvents(
  eventSource: WebhookEventSource,
  entryId: string,
  tenantId: string,
  preMicros: number,
  postMicros: number,
  thresholdMicros: number,
  lifecycle: BillingLifecycle,
): Promise<void> {
  const { low, exhausted } = detectBalanceCrossings(preMicros, postMicros, thresholdMicros);
  if (low) {
    await eventSource.emit(
      tenantId,
      "tenant.balance_low",
      crossingEventId(entryId, "tenant.balance_low"),
      undefined,
      balanceEventData(entryId, tenantId, postMicros, thresholdMicros, lifecycle),
    );
  }
  if (exhausted) {
    await eventSource.emit(
      tenantId,
      "tenant.balance_exhausted",
      crossingEventId(entryId, "tenant.balance_exhausted"),
      undefined,
      balanceEventData(entryId, tenantId, postMicros, thresholdMicros, lifecycle),
    );
  }
}

/**
 * Append a ledger entry ({@link appendEntry}) and, if it CROSSED a threshold, emit the
 * matching webhook event(s). This is the seam a ledger-draining consumer (the metering
 * aggregator) uses so a debit that takes the balance across the low line / to ≤ 0
 * notifies the tenant exactly once.
 *
 * **Emit is decoupled from append (F1).** "Did we append the entry" is idempotent by
 * the ledger key; "did we emit the crossing" is idempotent by the entry-derived event
 * id ({@link crossingEventId}) — the two are kept SEPARATE. Crucially the crossing is
 * derived from the resulting entry (`balanceAfterMicros` and its own `amountMicros`),
 * which is present on BOTH a fresh apply and a replay, and the emit runs on both
 * paths. So if a prior call committed the debit but then threw during the emit, the
 * metering retry re-runs this with the SAME key: the append is now a no-op replay
 * (`applied: false`) yet the crossing is STILL re-emitted — deduped by the stable
 * event id — instead of being silently lost forever. A crossing that already emitted
 * re-emits to the same delivery row (no duplicate); a debit already below the line
 * detects no crossing and emits nothing.
 */
export async function appendEntryWithThresholdEvents(
  pool: Pool,
  eventSource: WebhookEventSource,
  input: AppendEntryInput,
  thresholdMicros: number,
  opts: { forceLifecycle?: BillingLifecycle } = {},
): Promise<AppendEntryResult> {
  const result = await appendEntry(pool, input, opts);
  // Derive the crossing from the CAUSING entry — valid on a fresh apply and on a
  // replay alike (the existing entry carries the at-crossing balance). Do NOT early-
  // return on `applied: false`: that replay path is exactly a metering retry after a
  // failed emit, and it must re-attempt the (idempotent) emit so the crossing is not
  // lost (F1).
  const { entry } = result;
  const postMicros = entry.balanceAfterMicros;
  const preMicros = postMicros - entry.amountMicros;
  await emitBalanceThresholdEvents(
    eventSource,
    entry.id,
    input.tenantId,
    preMicros,
    postMicros,
    thresholdMicros,
    result.lifecycle,
  );
  return result;
}
