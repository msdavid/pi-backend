/**
 * Self-hosted work queue (WP-4.1, §10.4, §9.2).
 *
 * When a session is assigned to a `self_hosted` environment, a work item is
 * enqueued here instead of provisioning a cloud sandbox. A worker claims the
 * next item (`FOR UPDATE SKIP LOCKED`), runs tools locally on the subscriber
 * host, and posts results back as `user.tool_result` events (§9.2).
 *
 * One work item per self-hosted session (`session_id` is unique). Persistence is
 * tenant-scoped via {@link tenantScopedQuery} (§27.1).
 *
 * NOTE on session-runtime integration: {@link postResult} persists the
 * `user.tool_result` event on the work item (the worker→control-plane channel).
 * Feeding it into the live session runtime (the JSONL conversation log + the
 * agent turn loop) is the session manager's responsibility (WP-1.4/1.5); this
 * module is the durable queue + claim/result surface.
 */

import {
  tenantScopedQuery,
  type Pool,
  type TenantCtx,
} from "../../infra/db/index.js";
import { tenantScopedClientQuery } from "../../infra/db/tenant-scoped.js";
import { newId } from "../tenant/ids.js";
import { ApiError } from "../errors.js";
import type {
  ExecChunk,
  ExecOptions,
  ExecResult,
  ProvisionSpec,
  SandboxHandle,
  SandboxProvider,
  SandboxStatus,
} from "../ports.js";

/** Work-item lifecycle status (§10.4). */
export type WorkItemStatus = "queued" | "claimed" | "done" | "stopped";

/** Default claim lease (ROB-11): a `claimed` item unclaimed this long is reaped back to `queued`. */
export const DEFAULT_WORK_ITEM_LEASE_MS = 5 * 60_000;

/** The claim lease in ms from the environment, or {@link DEFAULT_WORK_ITEM_LEASE_MS}. */
export function workItemLeaseMs(): number {
  const raw = process.env.PI_WORK_ITEM_LEASE_MS;
  if (!raw) return DEFAULT_WORK_ITEM_LEASE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : DEFAULT_WORK_ITEM_LEASE_MS;
}

/**
 * The work specification enqueued for a self-hosted session: the initial events
 * (a `user.message` to start work, §9.2) + any config the worker needs. Opaque to
 * the queue; the worker interprets it.
 */
export interface WorkSpec {
  initialEvents?: unknown[];
  config?: Record<string, unknown>;
  /**
   * Tool executions the session's agent has requested and the worker must run on the
   * subscriber host (R6.6). Appended by {@link enqueueToolCall} — one entry per
   * `SandboxProvider.exec` the {@link SelfHostedToolChannel} intercepts. The worker
   * runs each and POSTs the output back to `/v1/sessions/:id/work-result` as a
   * `user.tool_result` carrying the same `toolUseId` (§9.2).
   */
  toolCalls?: SelfHostedToolCall[];
  [key: string]: unknown;
}

/** One tool execution handed to the subscriber's worker (R6.6, §10.4). */
export interface SelfHostedToolCall {
  /** Correlation id; the worker echoes it on the posted `user.tool_result`. */
  toolUseId: string;
  /** Command line (string ⇒ shell, array ⇒ argv), as handed to `SandboxProvider.exec`. */
  cmd: string | string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Seconds. */
  timeout?: number;
  requestedAt: string;
}

/** A `user.tool_result` event posted by the worker (§9.2). Opaque payload. */
export interface ToolResultEvent {
  type: "user.tool_result";
  tool?: string;
  output?: unknown;
  [key: string]: unknown;
}

/** DB row shape (snake_case + jsonb as parsed objects + dates). */
export interface WorkQueueRow {
  tenant_id: string;
  id: string;
  session_id: string;
  environment_id: string;
  status: string;
  work_spec: WorkSpec;
  results: unknown[];
  claimed_by: string | null;
  claimed_at: Date | null;
  queued_at: Date;
  completed_at: Date | null;
  stop_requested: string | null;
  stop_requested_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** ISO-string helper (contracts `Timestamp` is RFC 3339 UTC with `Z`). */
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** Wire shape for a work item returned to the worker / API. */
export interface WorkItem {
  id: string;
  sessionId: string;
  environmentId: string;
  status: WorkItemStatus;
  workSpec: WorkSpec;
  results: unknown[];
  claimedBy: string | null;
  claimedAt: string | null;
  queuedAt: string;
  completedAt: string | null;
  stopRequested: "clean" | "force" | null;
  stopRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Map a stored DB row to the wire {@link WorkItem}. */
export function toWorkItem(r: WorkQueueRow): WorkItem {
  return {
    id: r.id,
    sessionId: r.session_id,
    environmentId: r.environment_id,
    status: r.status as WorkItemStatus,
    workSpec: r.work_spec,
    results: r.results ?? [],
    claimedBy: r.claimed_by,
    claimedAt: iso(r.claimed_at),
    queuedAt: iso(r.queued_at) as string,
    completedAt: iso(r.completed_at),
    stopRequested: (r.stop_requested as "clean" | "force" | null) ?? null,
    stopRequestedAt: iso(r.stop_requested_at),
    createdAt: iso(r.created_at) as string,
    updatedAt: iso(r.updated_at) as string,
  };
}

/**
 * Enqueue a work item for a self-hosted session. Idempotent on `session_id`:
 * re-enqueueing for an already-queued session returns the existing item (the
 * caller may retry the enqueue trigger after a transient failure). Throws
 * `409 conflict` if a work item for the session already exists in a non-queued
 * (claimed/done/stopped) status — a session cannot be re-enqueued mid-work.
 */
export async function enqueue(
  pool: Pool,
  tenantCtx: TenantCtx,
  sessionId: string,
  environmentId: string,
  workSpec: WorkSpec,
): Promise<WorkItem> {
  const id = newId("work_");
  const spec: WorkSpec = {
    initialEvents: workSpec.initialEvents ?? [],
    ...(workSpec.config !== undefined ? { config: workSpec.config } : {}),
    ...workSpec,
  };
  try {
    const { rows } = await tenantScopedQuery<WorkQueueRow>(
      pool,
      tenantCtx,
      `INSERT INTO self_hosted_work_queue
         (tenant_id, id, session_id, environment_id, status, work_spec, results)
       VALUES ($1, $2, $3, $4, 'queued', $5::jsonb, '[]'::jsonb)
       RETURNING *`,
      [
        tenantCtx.tenantId,
        id,
        sessionId,
        environmentId,
        JSON.stringify(spec),
      ],
    );
    return toWorkItem(rows[0]);
  } catch (err) {
    // Unique-violation on session_id → an item already exists for this session.
    if (
      err instanceof Error &&
      "code" in err &&
      (err as { code: string }).code === "23505"
    ) {
      const existing = await fetchWorkItem(pool, tenantCtx, sessionId);
      if (existing && existing.status === "queued") return existing;
      throw new ApiError(
        409,
        "conflict",
        `work item already exists for session ${sessionId} (status: ${existing?.status ?? "unknown"})`,
      );
    }
    throw err;
  }
}

/**
 * Claim the next queued work item for `environmentId` (`FOR UPDATE SKIP LOCKED`,
 * §10.4). Atomically transitions the item to `claimed` and stamps
 * `claimed_by`/`claimed_at`. Returns `null` if the queue is empty.
 *
 * `workerKeyId` is the `apikey_…` id of the worker key making the claim (used
 * for attribution + the `workersPolling` stat). The route layer enforces that
 * the worker key is scoped to `environmentId`.
 */
export async function claim(
  pool: Pool,
  tenantCtx: TenantCtx,
  environmentId: string,
  workerKeyId: string,
): Promise<WorkItem | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // ROB-11: reap stale claims first. A worker that claimed an item then died (crash,
    // network partition, lost lease) would otherwise strand the item in `claimed` forever —
    // nothing else reaps it. Any claim whose `claimed_at` is older than the lease returns to
    // `queued` (claimed_by cleared) so this poll — or another worker's — can pick it up.
    await tenantScopedClientQuery(
      client,
      tenantCtx,
      `UPDATE self_hosted_work_queue
          SET status = 'queued', claimed_by = NULL, claimed_at = NULL, updated_at = now()
        WHERE tenant_id = $1 AND environment_id = $2 AND status = 'claimed'
          AND claimed_at < now() - ($3::int * interval '1 second')`,
      [tenantCtx.tenantId, environmentId, Math.ceil(workItemLeaseMs() / 1000)],
    );
    // FOR UPDATE SKIP LOCKED: concurrent workers each claim a distinct item.
    // Routed through tenantScopedClientQuery so the tenant_id assertion is
    // enforced on the transaction's connection (§27.1).
    const { rows } = await tenantScopedClientQuery<WorkQueueRow>(
      client,
      tenantCtx,
      `SELECT * FROM self_hosted_work_queue
        WHERE tenant_id = $1 AND environment_id = $2 AND status = 'queued'
        ORDER BY queued_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
      [tenantCtx.tenantId, environmentId],
    );
    const row = rows[0];
    if (!row) {
      await client.query("COMMIT");
      return null;
    }
    const { rows: updated } = await tenantScopedClientQuery<WorkQueueRow>(
      client,
      tenantCtx,
      `UPDATE self_hosted_work_queue
          SET status = 'claimed', claimed_by = $3, claimed_at = now(),
              updated_at = now()
        WHERE tenant_id = $1 AND id = $2
        RETURNING *`,
      [tenantCtx.tenantId, row.id, workerKeyId],
    );
    await client.query("COMMIT");
    return toWorkItem(updated[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Post a `user.tool_result` event (§9.2) for a self-hosted session. Appends the
 * event to the work item's `results` channel and bumps `updated_at`. Throws
 * `404 not_found` if no work item exists for the session (or it is in another
 * tenant). Throws `409 conflict` if the item is `stopped` (results cannot be
 * posted to a stopped session).
 */
export async function postResult(
  pool: Pool,
  tenantCtx: TenantCtx,
  sessionId: string,
  toolResultEvent: ToolResultEvent,
): Promise<WorkItem> {
  const item = await fetchWorkItem(pool, tenantCtx, sessionId);
  if (!item) {
    throw new ApiError(404, "not_found", `work item not found for session: ${sessionId}`);
  }
  if (item.status === "stopped") {
    throw new ApiError(
      409,
      "conflict",
      `work item for session ${sessionId} is stopped; cannot post results`,
    );
  }
  const event = { ...toolResultEvent, type: "user.tool_result" as const, postedAt: new Date().toISOString() };
  // ROB-22: guard the UPDATE with `status <> 'stopped'` so a stop that lands BETWEEN the
  // fetch above and this write can't append a result to a stopped item (the fetch-then-check
  // is not atomic). A 0-row result means the item was stopped concurrently → 409.
  const { rows } = await tenantScopedQuery<WorkQueueRow>(
    pool,
    tenantCtx,
    `UPDATE self_hosted_work_queue
        SET results = results || $3::jsonb, updated_at = now()
      WHERE tenant_id = $1 AND session_id = $2 AND status <> 'stopped'
      RETURNING *`,
    [tenantCtx.tenantId, sessionId, JSON.stringify([event])],
  );
  if (!rows[0]) {
    throw new ApiError(
      409,
      "conflict",
      `work item for session ${sessionId} is stopped; cannot post results`,
    );
  }
  return toWorkItem(rows[0]);
}

/** Fetch a work item by session id, or `null` if absent / cross-tenant. */
export async function fetchWorkItem(
  pool: Pool,
  tenantCtx: TenantCtx,
  sessionId: string,
): Promise<WorkItem | null> {
  const { rows } = await tenantScopedQuery<WorkQueueRow>(
    pool,
    tenantCtx,
    `SELECT * FROM self_hosted_work_queue WHERE tenant_id = $1 AND session_id = $2`,
    [tenantCtx.tenantId, sessionId],
  );
  return rows[0] ? toWorkItem(rows[0]) : null;
}

/**
 * Enqueue ONE tool execution for a self-hosted session (R6.6, §10.4).
 *
 * A self-hosted session has exactly one work item (`session_id` is unique), so the call
 * is APPENDED to that item's `work_spec.toolCalls` — creating the item on the first call.
 * If the item was already `claimed` (or `done`), it returns to `queued` so the worker's
 * next `work-claim` poll picks up the new call; `claimed_by` is left intact for
 * attribution. A `stopped` item accepts nothing more (`409`).
 *
 * The caller (`SelfHostedToolChannel.exec`) then awaits the `user.tool_result` the worker
 * posts back for this `toolUseId`.
 */
export async function enqueueToolCall(
  pool: Pool,
  tenantCtx: TenantCtx,
  sessionId: string,
  environmentId: string,
  call: SelfHostedToolCall,
): Promise<WorkItem> {
  const id = newId("work_");
  const calls = JSON.stringify([call]);
  const { rows } = await tenantScopedQuery<WorkQueueRow>(
    pool,
    tenantCtx,
    `INSERT INTO self_hosted_work_queue
       (tenant_id, id, session_id, environment_id, status, work_spec, results)
     VALUES ($1, $2, $3, $4, 'queued',
             jsonb_build_object('initialEvents', '[]'::jsonb, 'toolCalls', $5::jsonb),
             '[]'::jsonb)
     ON CONFLICT (session_id) DO UPDATE
        SET work_spec = jsonb_set(
              coalesce(self_hosted_work_queue.work_spec, '{}'::jsonb),
              '{toolCalls}',
              coalesce(self_hosted_work_queue.work_spec -> 'toolCalls', '[]'::jsonb)
                || $5::jsonb),
            status = CASE
              WHEN self_hosted_work_queue.status IN ('claimed', 'done') THEN 'queued'
              ELSE self_hosted_work_queue.status
            END,
            updated_at = now()
      WHERE self_hosted_work_queue.tenant_id = $1
        AND self_hosted_work_queue.status <> 'stopped'
     RETURNING *`,
    [tenantCtx.tenantId, id, sessionId, environmentId, calls],
  );
  if (!rows[0]) {
    throw new ApiError(
      409,
      "conflict",
      `work item for session ${sessionId} is stopped; cannot enqueue tool calls`,
    );
  }
  return toWorkItem(rows[0]);
}

// ---------------------------------------------------------------------------
// Worker → live-runtime delivery (R6.6)
// ---------------------------------------------------------------------------

/**
 * The sink that carries a worker-posted `user.tool_result` into the LIVE session runtime
 * (R6.6). Without it the round trip dead-ends in the `results` column: the model's tool
 * call never resolves.
 *
 * Registered by the composition root (`app.ts`), which resolves the runtime through the
 * `SessionManager` and calls `sendEvent({type:"user.tool_result", …})`. It is a
 * process-level registration because `server.ts` constructs the self-hosted plugin with
 * only a pool — the sink is the seam that lets the composition root reach in without the
 * route layer knowing about the session registry.
 */
export interface ToolResultSink {
  deliver(
    sessionId: string,
    result: { toolUseId: string; result: string; isError: boolean },
  ): Promise<void>;
}

let toolResultSink: ToolResultSink | undefined;

/** Register the live-runtime sink (composition root). */
export function setToolResultSink(sink: ToolResultSink): void {
  toolResultSink = sink;
}

/** Unregister the sink (app shutdown / test isolation). */
export function clearToolResultSink(): void {
  toolResultSink = undefined;
}

/** The registered sink, or `undefined` (no live runtime on this node). */
export function getToolResultSink(): ToolResultSink | undefined {
  return toolResultSink;
}

// ---------------------------------------------------------------------------
// SelfHostedToolChannel — SandboxProvider over the work queue (R6.6)
// ---------------------------------------------------------------------------

/**
 * Executes a session's tools on the SUBSCRIBER's worker instead of a cloud microVM
 * (§10.4). It implements {@link SandboxProvider} so everything above the seam — the
 * materialized toolset, the wake lifecycle, the idle policy — is unchanged:
 *
 * - `provision` creates NO VM. It returns a virtual handle naming the session; the work
 *   item itself is created lazily by the first {@link exec}.
 * - `exec` enqueues a {@link SelfHostedToolCall} and awaits the `user.tool_result` the
 *   worker POSTs to `/v1/sessions/:id/work-result`. The pending resolver lives in the
 *   runtime's `user.tool_result` map (`awaitToolResult`), so an unanswered call shows up
 *   in `blockingEventIds` and the turn settles as `requires_action` (§9.2) rather than
 *   hanging silently.
 * - lifecycle calls (`start`/`stop`/`snapshot`/`status`) are no-ops on a host the control
 *   plane does not own; `destroy` marks the work item done.
 * - `registerSecretBinding` REFUSES: env-var credentials are an unsupported feature on
 *   self-hosted environments (§10.4 / `constraints.ts`), enforced again here so no path
 *   can smuggle one onto the subscriber's host.
 */
export class SelfHostedToolChannel implements SandboxProvider {
  private readonly pool: Pool;
  private readonly tenantCtx: TenantCtx;
  private readonly sessionId: string;
  private readonly environmentId: string;
  private readonly awaitToolResult: (
    toolUseId: string,
  ) => Promise<{ result: string; isError: boolean }>;

  constructor(opts: {
    pool: Pool;
    tenantId: string;
    sessionId: string;
    environmentId: string;
    awaitToolResult(
      toolUseId: string,
    ): Promise<{ result: string; isError: boolean }>;
  }) {
    this.pool = opts.pool;
    this.tenantCtx = { tenantId: opts.tenantId };
    this.sessionId = opts.sessionId;
    this.environmentId = opts.environmentId;
    this.awaitToolResult = opts.awaitToolResult.bind(opts);
  }

  async provision(spec: ProvisionSpec): Promise<SandboxHandle> {
    return {
      id: spec.name,
      name: spec.name,
      labels: spec.labels,
    };
  }

  async exec(_handle: SandboxHandle, opts: ExecOptions): Promise<ExecResult> {
    const toolUseId = newId("tool_");
    // Register the pending resolver BEFORE the enqueue: the worker may post the result
    // before the enqueue promise settles on a fast local loop.
    const pending = this.awaitToolResult(toolUseId);
    await enqueueToolCall(
      this.pool,
      this.tenantCtx,
      this.sessionId,
      this.environmentId,
      {
        toolUseId,
        cmd: opts.cmd,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.env !== undefined ? { env: opts.env } : {}),
        ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
        requestedAt: new Date().toISOString(),
      },
    );
    const posted = await pending;
    return posted.isError
      ? { stdout: "", stderr: posted.result, exitCode: 1 }
      : { stdout: posted.result, stderr: "", exitCode: 0 };
  }

  async *execStream(
    handle: SandboxHandle,
    opts: ExecOptions,
  ): AsyncIterable<ExecChunk> {
    // The worker posts one complete result per call (§10.4 has no streaming channel), so
    // the stream is the finished output, delivered as a single chunk.
    const r = await this.exec(handle, opts);
    if (r.stdout) yield { stream: "stdout", data: r.stdout };
    if (r.stderr) yield { stream: "stderr", data: r.stderr };
  }

  async stop(_handle: SandboxHandle): Promise<void> {
    /* no VM to checkpoint — the worker host is the subscriber's */
  }

  async start(_handle: SandboxHandle): Promise<void> {
    /* no VM to boot */
  }

  async snapshot(_handle: SandboxHandle): Promise<string> {
    throw new ApiError(
      422,
      "invalid_request",
      "snapshots are not supported on a self_hosted environment (§10.4)",
    );
  }

  async destroy(_handle: SandboxHandle): Promise<void> {
    await completeWorkItem(this.pool, this.tenantCtx, this.sessionId);
  }

  /**
   * Read the work item's posted `user.tool_result` rows (ROB-10). The runtime replays these
   * into itself on wake/reattach so a result delivered while this runtime was evicted — or
   * to another node — is not stranded in the `results` column: it reaches the (re-)awaiting
   * tool call. Returns [] if no work item exists yet.
   */
  async drainPostedResults(): Promise<
    Array<{ toolUseId: string; result: string; isError: boolean }>
  > {
    const item = await fetchWorkItem(this.pool, this.tenantCtx, this.sessionId);
    if (!item) return [];
    const out: Array<{ toolUseId: string; result: string; isError: boolean }> = [];
    for (const row of item.results ?? []) {
      const ev = row as {
        type?: string;
        toolUseId?: string;
        result?: string;
        isError?: boolean;
      };
      if (ev?.type === "user.tool_result" && typeof ev.toolUseId === "string") {
        out.push({
          toolUseId: ev.toolUseId,
          result: String(ev.result ?? ""),
          isError: Boolean(ev.isError),
        });
      }
    }
    return out;
  }

  async reattachByLabels(): Promise<SandboxHandle[]> {
    return []; // the control plane owns no VMs for this environment
  }

  async status(_handle: SandboxHandle): Promise<SandboxStatus> {
    // The channel is always available: the worker's absence is expressed as an unanswered
    // tool call (`requires_action`), never as a crashed VM (which would re-provision).
    return "running";
  }

  async registerSecretBinding(): Promise<void> {
    throw new ApiError(
      422,
      "invalid_request",
      "environment_variable credentials are not supported on a self_hosted " +
        "environment (§10.4)",
    );
  }
}

/**
 * The {@link SelfHostedChannelFactory} the composition root injects into the session
 * runtime: builds a {@link SelfHostedToolChannel} bound to the pool + the session.
 */
export function createSelfHostedChannelFactory(pool: Pool) {
  return {
    create(opts: {
      tenantId: string;
      sessionId: string;
      environmentId: string;
      awaitToolResult(
        toolUseId: string,
      ): Promise<{ result: string; isError: boolean }>;
    }): SandboxProvider {
      return new SelfHostedToolChannel({ pool, ...opts });
    },
  };
}

/**
 * Mark a claimed/queued work item done (the worker finished). Idempotent on an
 * already-done item. Returns the updated item, or `null` if absent.
 */
export async function completeWorkItem(
  pool: Pool,
  tenantCtx: TenantCtx,
  sessionId: string,
): Promise<WorkItem | null> {
  const { rows } = await tenantScopedQuery<WorkQueueRow>(
    pool,
    tenantCtx,
    `UPDATE self_hosted_work_queue
        SET status = 'done', completed_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND session_id = $2 AND status NOT IN ('done', 'stopped')
      RETURNING *`,
    [tenantCtx.tenantId, sessionId],
  );
  return rows[0] ? toWorkItem(rows[0]) : null;
}
