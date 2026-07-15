/**
 * Webhook dispatcher (WP-2.5, §23, §23.5).
 *
 * Implements {@link WebhookSink.dispatch} (the Phase-1 enqueue seam) and runs the
 * persisted at-least-once retry loop:
 *
 * - `dispatch(event)` / `enqueueForTenant(tenantId, event)` → fan out a thin
 *   payload (`type`+`id`+`createdAt`) to every **active** webhook subscribed to
 *   the event type, inserting a `pending` `webhook_deliveries` row. The enqueue
 *   is idempotent per `(webhook_id, event_id)`: a pending row is reused, a
 *   succeeded row is skipped — so the same `event.id` is carried across retries.
 * - `tick()` → poll due `pending` deliveries, deliver each (HTTPS POST, 2xx-only
 *   ack, **no redirect following**), record `last_response_code`, and on failure
 *   schedule `next_attempt_at` via exponential backoff (at-least-once; same
 *   `event.id` across retries). Auto-disable after the streak threshold, or
 *   immediately on private-IP resolution / redirect (§23.5).
 *
 * No new deps — global `fetch`, `node:dns`, `node:crypto` only.
 */

import { query, tenantScopedQuery, type Pool, type TenantCtx } from "../../infra/db/index.js";
import {
  recordWebhookDelivery,
  SpanAttrs,
  SpanNames,
  withSpan,
} from "../../infra/telemetry/conventions.js";
import type { Logger } from "pino";
import type { WebhookEvent, WebhookSink } from "../ports.js";
import type { TenantId } from "../ports.js";
import { newId } from "../tenant/ids.js";
import {
  defaultWebhookDnsResolver,
  type WebhookDnsResolver,
  WebhookSsrfError,
} from "./ssrf.js";
import { safeFetchPinned } from "../net/ssrf-pin.js";
import { sign as signPayload } from "./signature.js";
import {
  disableWebhook,
  shouldDisableForStreak,
  DISABLE_REASON,
  DISABLE_STREAK_THRESHOLD,
} from "./auto-disable.js";
import { getWebhookWithSecret } from "./webhook.js";

/** Default poll interval for the retry loop. */
export const DEFAULT_DISPATCHER_INTERVAL_MS = 10_000;
/** Default batch size per tick. */
export const DEFAULT_DISPATCHER_BATCH = 50;
/**
 * Default max deliveries attempted concurrently within one tick. Bounds the batch
 * so a single hung endpoint can't stall the rest (ROB-1), while capping how many
 * sockets + pool connections one tick opens at once.
 */
export const DEFAULT_DELIVERY_CONCURRENCY = 8;
/** Cap on delivery attempts (also bounds the streak auto-disable). */
export const DEFAULT_MAX_ATTEMPTS = DISABLE_STREAK_THRESHOLD;

/** Reset `delivering` rows claimed longer than this ago (crashed node). */
export const DEFAULT_REAP_STUCK_MS = 5 * 60_000; // 5 min

/** Default exponential backoff (ms) for attempt N (1-based), capped at 1h. */
export function defaultBackoff(attempt: number): number {
  const base = 60_000; // 1 min
  const cap = 60 * 60 * 1000; // 1 h
  return Math.min(cap, base * 2 ** (attempt - 1));
}

export interface DispatcherOptions {
  pool: Pool;
  logger?: Logger;
  intervalMs?: number;
  batch?: number;
  maxAttempts?: number;
  /** Max deliveries attempted concurrently per tick (default {@link DEFAULT_DELIVERY_CONCURRENCY}). */
  deliveryConcurrency?: number;
  /** Reset `delivering` rows stuck longer than this (ms) back to `pending`. */
  reapStuckAfterMs?: number;
  backoff?: (attempt: number) => number;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Injectable DNS resolver (tests). */
  dnsResolver?: WebhookDnsResolver;
  /** Injectable clock (tests). */
  now?: () => Date;
}

export interface DispatcherHandle {
  /** Stop the background retry loop. */
  stop(): void;
  /** Run one poll → deliver batch (for tests / manual driving). */
  tick(): Promise<void>;
}

interface PendingDeliveryRow {
  id: string;
  tenant_id: string;
  webhook_id: string;
  event_id: string;
  event_type: string;
  payload: { type: string; id: string; createdAt: string };
  attempt: number;
}

interface ActiveWebhookRow {
  tenant_id: string;
  id: string;
}

/**
 * The webhook dispatcher: enqueue seam + retry loop. Implements {@link WebhookSink}
 * for the Phase-1 global fanout (all active webhooks across tenants subscribed to
 * the event type). Prefer {@link enqueueForTenant} from event sources for
 * tenant-scoped isolation.
 */
export class WebhookDispatcher implements WebhookSink {
  private readonly pool: Pool;
  private readonly logger?: Logger;
  private readonly intervalMs: number;
  private readonly batch: number;
  private readonly maxAttempts: number;
  private readonly deliveryConcurrency: number;
  private readonly reapStuckAfterMs: number;
  private readonly backoff: (attempt: number) => number;
  /** Injected fetch (tests). Undefined in production → the pinned transport runs. */
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly dnsResolver: WebhookDnsResolver;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Guard so an overlapping timer fire can't stack a second tick over a running one. */
  private inFlight = false;

  constructor(opts: DispatcherOptions) {
    this.pool = opts.pool;
    this.logger = opts.logger;
    this.intervalMs = opts.intervalMs ?? DEFAULT_DISPATCHER_INTERVAL_MS;
    this.batch = opts.batch ?? DEFAULT_DISPATCHER_BATCH;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.deliveryConcurrency = opts.deliveryConcurrency ?? DEFAULT_DELIVERY_CONCURRENCY;
    this.reapStuckAfterMs = opts.reapStuckAfterMs ?? DEFAULT_REAP_STUCK_MS;
    this.backoff = opts.backoff ?? defaultBackoff;
    this.fetchImpl = opts.fetchImpl;
    this.dnsResolver = opts.dnsResolver ?? defaultWebhookDnsResolver;
    this.now = opts.now ?? (() => new Date());
  }

  // --- WebhookSink (global fanout, §23.1) --------------------------------

  /** @inheritdoc — enqueue to ALL active webhooks subscribed to `event.type`. */
  async dispatch(event: WebhookEvent): Promise<void> {
    await this.fanout(null, event);
  }

  /**
   * Enqueue `event` to the active webhooks of a **single tenant**. This is the
   * tenant-scoped path the event sources (session/vault/job) should use.
   */
  async enqueueForTenant(tenantId: TenantId, event: WebhookEvent): Promise<void> {
    await this.fanout(tenantId, event);
  }

  /** Shared fanout: find matching active webhooks and enqueue idempotently. */
  private async fanout(tenantId: TenantId | null, event: WebhookEvent): Promise<void> {
    const rows = await this.findActiveWebhooksForType(tenantId, event.type);
    if (rows.length === 0) return;
    for (const wh of rows) {
      await this.enqueueDelivery(wh.tenant_id, wh.id, event);
    }
  }

  /** Find active webhooks (optionally tenant-scoped) subscribed to `eventType`. */
  private async findActiveWebhooksForType(
    tenantId: TenantId | null,
    eventType: string,
  ): Promise<ActiveWebhookRow[]> {
    if (tenantId) {
      const { rows } = await tenantScopedQuery<ActiveWebhookRow>(
        this.pool,
        { tenantId },
        `SELECT tenant_id, id FROM webhooks
          WHERE tenant_id = $1 AND status = 'active'
            AND event_types @> $2::jsonb`,
        [tenantId, JSON.stringify([eventType])],
      );
      return rows;
    }
    // Cross-tenant fanout (WebhookSink global seam).
    const { rows } = await query<ActiveWebhookRow>(
      this.pool,
      `SELECT tenant_id, id FROM webhooks
        WHERE status = 'active' AND event_types @> $1::jsonb`,
      [JSON.stringify([eventType])],
    );
    return rows;
  }

  /**
   * Idempotently enqueue a delivery for `(webhookId, event.id)`. The unique
   * index on `(webhook_id, event_id)` (migration 033) makes `ON CONFLICT DO
   * NOTHING` the real dedup: a concurrent double-enqueue collapses to one row,
   * and a row already present (pending, delivering, succeeded, or failed) is
   * never duplicated. This replaces the check-then-act that raced.
   */
  private async enqueueDelivery(
    tenantId: TenantId,
    webhookId: string,
    event: WebhookEvent,
  ): Promise<void> {
    const payload = {
      type: event.type,
      id: event.id,
      createdAt: event.createdAt,
    };
    await tenantScopedQuery(
      this.pool,
      { tenantId },
      `INSERT INTO webhook_deliveries
         (tenant_id, id, webhook_id, event_id, event_type, payload, attempt, status, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 'pending', $7)
       ON CONFLICT (webhook_id, event_id) DO NOTHING`,
      [
        tenantId,
        newId("whd_"),
        webhookId,
        event.id,
        event.type,
        JSON.stringify(payload),
        this.now(),
      ],
    );
  }

  // --- Retry loop ----------------------------------------------------------

  /** Start the background poll loop. Returns a handle with `stop()` + `tick()`. */
  start(): DispatcherHandle {
    if (this.timer) return this;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        this.logger?.warn({ err: String(err) }, "webhook dispatcher tick failed");
      });
    }, this.intervalMs);
    return this;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Poll once: reap stuck claims, claim due pending deliveries, deliver the batch
   * with bounded concurrency. Re-entrancy is guarded — if a previous tick is still
   * running (slow/hung endpoints), an overlapping timer fire returns immediately
   * instead of stacking a second concurrent poll (ROB-1).
   */
  async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      await this.reapStuck().catch((err) => {
        this.logger?.warn({ err: String(err) }, "webhook dispatcher reaper failed");
      });
      const due = await this.claimDue();
      await this.deliverBatch(due);
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Deliver a claimed batch with bounded parallelism ({@link deliveryConcurrency}):
   * a fixed pool of workers drains the queue so one hung endpoint can't stall the
   * others (ROB-1), instead of the strictly-sequential loop that did. An unexpected
   * error (e.g. DB/pool failure — `deliverOne` handles HTTP/SSRF outcomes itself) is
   * scheduled for retry, not marked terminally failed (ROB-19); if even the retry
   * write fails the row stays `delivering` and the reaper recovers it.
   */
  private async deliverBatch(due: PendingDeliveryRow[]): Promise<void> {
    if (due.length === 0) return;
    const limit = Math.max(1, Math.min(this.deliveryConcurrency, due.length));
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < due.length) {
        const d = due[next++];
        try {
          await this.deliverOne(d);
        } catch (err) {
          this.logger?.warn(
            { err: String(err), deliveryId: d.id, webhookId: d.webhook_id },
            "webhook delivery attempt errored",
          );
          await this.scheduleRetry(d, { tenantId: d.tenant_id }, d.webhook_id, undefined).catch(
            () => {},
          );
        }
      }
    };
    await Promise.all(Array.from({ length: limit }, () => worker()));
  }

  /**
   * Atomically claim a batch of due pending deliveries and flip them to
   * `delivering` in one transaction (multi-node safety, R5.4). The claim
   * `SELECT … FOR UPDATE SKIP LOCKED` holds the row locks only until COMMIT;
   * committing the `status='delivering'` flip inside the same transaction is
   * what makes another node's `status='pending'` claim skip these rows once the
   * locks release. `markSucceeded`/`markFailed`/`scheduleRetry` later move each
   * row off `delivering`; the reaper recovers rows abandoned by a crashed node.
   */
  private async claimDue(): Promise<PendingDeliveryRow[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: locked } = await client.query<{ id: string }>(
        `SELECT id FROM webhook_deliveries
          WHERE status = 'pending'
            AND (next_attempt_at IS NULL OR next_attempt_at <= now())
          ORDER BY next_attempt_at NULLS FIRST
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [this.batch],
      );
      if (locked.length === 0) {
        await client.query("COMMIT");
        return [];
      }
      const ids = locked.map((r) => r.id);
      const { rows } = await client.query<PendingDeliveryRow>(
        `UPDATE webhook_deliveries
            SET status = 'delivering', claimed_at = now()
          WHERE id = ANY($1)
          RETURNING id, tenant_id, webhook_id, event_id, event_type, payload, attempt`,
        [ids],
      );
      await client.query("COMMIT");
      return rows;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Reset deliveries stuck in `delivering` past {@link reapStuckAfterMs} back to
   * `pending` — recovering rows a node claimed but crashed before finishing.
   * Returns the number of rows reclaimed.
   */
  private async reapStuck(): Promise<number> {
    const { rowCount } = await query(
      this.pool,
      `UPDATE webhook_deliveries
          SET status = 'pending', claimed_at = NULL
        WHERE status = 'delivering'
          AND claimed_at IS NOT NULL
          AND claimed_at < now() - ($1::double precision * interval '1 millisecond')`,
      [this.reapStuckAfterMs],
    );
    return rowCount ?? 0;
  }

  /**
   * Deliver one pending row: SSRF-resolve, POST (no redirects), record result.
   *
   * Wrapped in the `pi.webhook.delivery` span (WP-8.1). The terminal outcome metric
   * (`pi.webhook.deliveries`) is emitted by the three `mark*`/`scheduleRetry` helpers
   * below, so it is recorded on EVERY path out of here — including the ones that also
   * auto-disable the webhook — without this method having to grow an exit funnel.
   */
  private async deliverOne(d: PendingDeliveryRow): Promise<void> {
    return withSpan(SpanNames.WEBHOOK_DELIVERY, async (span) => {
      span.setAttributes({
        [SpanAttrs.TENANT_ID]: d.tenant_id,
        [SpanAttrs.WEBHOOK_ID]: d.webhook_id,
        [SpanAttrs.EVENT_TYPE]: d.event_type,
        [SpanAttrs.RETRY_ATTEMPT]: d.attempt,
      });
      await this.deliverOneInner(d);
    });
  }

  private async deliverOneInner(d: PendingDeliveryRow): Promise<void> {
    const tenantCtx: TenantCtx = { tenantId: d.tenant_id };
    const wh = await getWebhookWithSecret(this.pool, tenantCtx, d.webhook_id);
    if (!wh) {
      // Webhook gone; mark delivery failed (terminal) without retry.
      await this.markFailed(d, undefined);
      return;
    }
    if (wh.status === "disabled") {
      // Skip disabled webhooks; leave pending so it resumes if re-enabled, or
      // mark failed to stop the loop. Per §23.5 (manual re-enable), mark failed.
      await this.markFailed(d, undefined);
      return;
    }

    const rawBody = JSON.stringify(d.payload);
    const signature = signPayload(rawBody, wh.signingSecret, this.now());

    // SSRF: resolve + assert public and connect to the *validated* IP (no rebind
    // window), keeping the hostname for SNI/cert validation. Redirects are not
    // followed (§23.5). Immediate disable on private-IP resolution.
    let res: Response;
    try {
      const { response } = await safeFetchPinned(
        wh.url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-webhook-signature": signature,
          },
          body: rawBody,
          redirect: "manual", // redirects NOT followed (§23.5)
        },
        this.dnsResolver,
        {
          fetchImpl: this.fetchImpl,
          errorFactory: (message, reason) => new WebhookSsrfError(message, reason),
        },
      );
      res = response;
    } catch (err) {
      if (err instanceof WebhookSsrfError) {
        await disableWebhook(this.pool, tenantCtx, wh.id, DISABLE_REASON.privateIp);
        await this.markFailed(d, undefined);
        return;
      }
      // Transient DNS / network error → retry.
      await this.scheduleRetry(d, tenantCtx, wh.id, undefined);
      return;
    }

    const code = res.status;

    // `redirect: "manual"` surfaces a 3xx as an opaqueredirect response (the
    // status is unreadable). Any redirect → immediate disable (§23.5).
    if (res.type === "opaqueredirect" || (code >= 300 && code < 400)) {
      await disableWebhook(this.pool, tenantCtx, wh.id, DISABLE_REASON.redirect);
      await this.markFailed(d, undefined);
      return;
    }

    // 2xx → ack (stop retries).
    if (code >= 200 && code < 300) {
      await this.markSucceeded(d, code);
      return;
    }

    // 4xx/5xx → retry (at-least-once).
    await this.scheduleRetry(d, tenantCtx, wh.id, code);
  }

  /** Attributes shared by every `pi.webhook.deliveries` observation for `d`. */
  private deliveryAttrs(
    d: PendingDeliveryRow,
    code: number | undefined,
  ): Record<string, string | number> {
    return {
      [SpanAttrs.TENANT_ID]: d.tenant_id,
      [SpanAttrs.WEBHOOK_ID]: d.webhook_id,
      [SpanAttrs.EVENT_TYPE]: d.event_type,
      ...(code !== undefined ? { [SpanAttrs.HTTP_STATUS_CODE]: code } : {}),
    };
  }

  /** Mark a delivery succeeded (2xx ack). */
  private async markSucceeded(d: PendingDeliveryRow, code: number): Promise<void> {
    await tenantScopedQuery(
      this.pool,
      { tenantId: d.tenant_id },
      `UPDATE webhook_deliveries
          SET status = 'succeeded', last_response_code = $3, next_attempt_at = NULL
        WHERE tenant_id = $1 AND id = $2`,
      [d.tenant_id, d.id, code],
    );
    recordWebhookDelivery("succeeded", this.deliveryAttrs(d, code));
  }

  /** Mark a delivery failed (terminal — no further retry). */
  private async markFailed(
    d: PendingDeliveryRow,
    code: number | undefined,
  ): Promise<void> {
    await tenantScopedQuery(
      this.pool,
      { tenantId: d.tenant_id },
      `UPDATE webhook_deliveries
          SET status = 'failed', last_response_code = $3, next_attempt_at = NULL
        WHERE tenant_id = $1 AND id = $2`,
      [d.tenant_id, d.id, code ?? null],
    );
    recordWebhookDelivery("failed", this.deliveryAttrs(d, code));
  }

  /**
   * Schedule a retry: increment attempt, set next_attempt_at via backoff. If the
   * streak threshold is reached, auto-disable the webhook and mark the delivery
   * failed (terminal).
   */
  private async scheduleRetry(
    d: PendingDeliveryRow,
    tenantCtx: TenantCtx,
    webhookId: string,
    code: number | undefined,
  ): Promise<void> {
    const nextAttempt = d.attempt + 1;
    if (shouldDisableForStreak(nextAttempt, this.maxAttempts)) {
      await disableWebhook(this.pool, tenantCtx, webhookId, DISABLE_REASON.streak);
      await this.markFailed(d, code);
      return;
    }
    const nextAt = new Date(this.now().getTime() + this.backoff(nextAttempt));
    // Move the row back off 'delivering' → 'pending' so the retry loop (this or
    // another node) re-claims it once next_attempt_at is due.
    await tenantScopedQuery(
      this.pool,
      tenantCtx,
      `UPDATE webhook_deliveries
          SET attempt = $3, last_response_code = $4, next_attempt_at = $5,
              status = 'pending', claimed_at = NULL
        WHERE tenant_id = $1 AND id = $2`,
      [tenantCtx.tenantId, d.id, nextAttempt, code ?? null, nextAt],
    );
    recordWebhookDelivery("retried", this.deliveryAttrs(d, code));
  }
}

/**
 * Start the dispatcher retry loop. The handle's `stop()` is wired into
 * `app.close()` by the caller (server.ts). Opt-in: tests drive `tick()`
 * directly without a background timer.
 */
export function startDispatcherLoop(opts: DispatcherOptions): DispatcherHandle {
  const dispatcher = new WebhookDispatcher(opts);
  return dispatcher.start();
}
