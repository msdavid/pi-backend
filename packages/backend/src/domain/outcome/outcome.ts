/**
 * Outcome domain service (WP-3.2, §16.3/§16.5).
 *
 * CRUD over `session_outcomes` (docs/db-schema.md §3.11). Every query routes through
 * {@link tenantScopedQuery} so cross-tenant access is impossible by construction
 * (§27.1). Enforces the one-outcome-at-a-time invariant (§16.5: `409` if an outcome
 * is active) and the `maxIterations` bounds (default 3, max 20, §16.3).
 *
 * Outcome lifecycle (§16.5): `active` → (graded) `satisfied` | `needs_revision` |
 * `max_iterations_reached` | `failed` | `interrupted`. Terminal results are
 * `satisfied`, `max_iterations_reached`, `failed`, `interrupted`; after a terminal
 * result the session is idle and a new `user.define_outcome` may be sent (chainable).
 *
 * The iteration loop itself lives in `iteration.ts`; this service owns persistence.
 */

import {
  tenantScopedQuery,
  type Pool,
  type TenantCtx,
} from "../../infra/db/index.js";
import { ApiError } from "../errors.js";
import { newId } from "../tenant/ids.js";
import { fetchSessionRow } from "../session/session-repo.js";
import {
  OutcomeCreate,
  type Outcome,
  type OutcomeResult,
  type OutcomeRubric,
  type OutcomeStatus,
} from "@pi-managed/contracts";

/** Default iteration cap (§16.3). */
export const DEFAULT_MAX_ITERATIONS = 3;
/** Hard ceiling on `maxIterations` (§16.3). */
export const MAX_MAX_ITERATIONS = 20;

/**
 * Default wall-clock cap on one outcome loop (30 min, R6.3). Override with
 * `OUTCOME_TIMEOUT_MS`. The same cap drives {@link expireStaleOutcomes}, so a row whose
 * loop never ran cannot 409-block the session past the deadline.
 */
export const DEFAULT_OUTCOME_TIMEOUT_MS = 30 * 60_000;

/** The configured outcome timeout (ms). `0` disables the cap. */
export function outcomeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OUTCOME_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_OUTCOME_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_OUTCOME_TIMEOUT_MS;
}

/** Statuses that block a new outcome being defined (one-at-a-time, §16.5). */
const ACTIVE_STATUSES: ReadonlySet<OutcomeStatus> = new Set([
  "active",
  "needs_revision",
]);

/** Terminal results — after these the session is idle (chainable, §16.5). */
const TERMINAL_RESULTS: ReadonlySet<OutcomeResult> = new Set([
  "satisfied",
  "max_iterations_reached",
  "failed",
  "interrupted",
]);

export function isTerminalResult(r: OutcomeResult): boolean {
  return TERMINAL_RESULTS.has(r);
}

// ---------------------------------------------------------------------------
// Row shape & mapping
// ---------------------------------------------------------------------------

/** `session_outcomes` row (snake_case; jsonb columns arrive parsed). */
export interface OutcomeRow {
  tenant_id: string;
  session_id: string;
  id: string;
  description: string;
  rubric: OutcomeRubric;
  max_iterations: number;
  status: string;
  result: string | null;
  iteration: number;
  created_at: Date;
}

const iso = (d: Date): string => d.toISOString();

/** Build the wire `Outcome` resource from a db row. */
export function toOutcome(row: OutcomeRow): Outcome {
  const out: Outcome = {
    id: row.id,
    status: row.status as OutcomeStatus,
    iteration: row.iteration,
    createdAt: iso(row.created_at),
  };
  if (row.description) out.description = row.description;
  if (row.result) out.result = row.result as OutcomeResult;
  return out;
}

// ---------------------------------------------------------------------------
// Define (§16.3)
// ---------------------------------------------------------------------------

/** Input to {@link defineOutcome} (validated against the contracts schema). */
export interface DefineOutcomeInput {
  description: string;
  rubric: OutcomeRubric;
  maxIterations?: number;
}

/**
 * Define a new outcome for a session — equivalent to `user.define_outcome` (§16.3).
 * Validates the session exists (404), enforces one-at-a-time (409 if an outcome is
 * active, §16.5), and clamps `maxIterations` (default 3, max 20, §16.3). Stores the
 * outcome as `status: "active"`, `iteration: 0`; the iteration loop is driven
 * separately (see `iteration.ts`).
 */
export async function defineOutcome(
  pool: Pool,
  tenantCtx: TenantCtx,
  sessionId: string,
  input: unknown,
): Promise<Outcome> {
  const parsed = OutcomeCreate.safeParse(input);
  if (!parsed.success) {
    throw new ApiError(
      422,
      "invalid_request",
      `invalid outcome: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  const data = parsed.data;

  // Session must exist + be visible to the tenant (404 otherwise).
  const session = await fetchSessionRow(pool, tenantCtx, sessionId);
  if (!session || session.status === "archived") {
    throw new ApiError(404, "not_found", `session not found: ${sessionId}`);
  }

  // R6.3: reap outcomes whose loop never settled (never driven, or the process that
  // owned the loop died). Without this, one stuck `active` row 409-blocks every future
  // outcome on the session forever.
  await expireStaleOutcomes(pool, tenantCtx, sessionId);

  // One outcome at a time (§16.5): reject if any non-terminal outcome exists.
  const active = await fetchActiveOutcomeRow(pool, tenantCtx, sessionId);
  if (active) {
    throw new ApiError(
      409,
      "conflict",
      `session already has an active outcome: ${active.id} (§16.5)`,
    );
  }

  const maxIterations = data.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const id = newId("outc_");
  const { rows } = await tenantScopedQuery<OutcomeRow>(
    pool,
    tenantCtx,
    `INSERT INTO session_outcomes
       (tenant_id, session_id, id, description, rubric, max_iterations,
        status, result, iteration)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'active', NULL, 0)
     RETURNING *`,
    [
      tenantCtx.tenantId,
      sessionId,
      id,
      data.description,
      JSON.stringify(data.rubric),
      maxIterations,
    ],
  );
  return toOutcome(rows[0]);
}

// ---------------------------------------------------------------------------
// List (§"GET outcomes")
// ---------------------------------------------------------------------------

export interface ListOutcomesOptions {
  limit: number;
  cursor?: string;
}

function decodeListCursor(cursor: string): { createdAt: string; id: string } {
  const json = Buffer.from(cursor, "base64url").toString("utf8");
  const parsed = JSON.parse(json) as { createdAt?: string; id?: string };
  if (!parsed.createdAt || !parsed.id) {
    throw new ApiError(400, "invalid_request", "invalid outcomes list cursor");
  }
  return { createdAt: parsed.createdAt, id: parsed.id };
}

/** List outcomes for a session, newest-first, cursor-paginated (§GET outcomes). */
export async function listOutcomes(
  pool: Pool,
  tenantCtx: TenantCtx,
  sessionId: string,
  opts: ListOutcomesOptions,
): Promise<{ data: Outcome[]; nextCursor: string | null }> {
  // Confirm the session exists + is visible (404 otherwise).
  const session = await fetchSessionRow(pool, tenantCtx, sessionId);
  if (!session || session.status === "archived") {
    throw new ApiError(404, "not_found", `session not found: ${sessionId}`);
  }
  const params: unknown[] = [tenantCtx.tenantId, sessionId];
  const where: string[] = ["tenant_id = $1", "session_id = $2"];
  let n = 2;
  if (opts.cursor) {
    const { createdAt, id } = decodeListCursor(opts.cursor);
    where.push(`(created_at, id) < ($${++n}, $${++n})`);
    params.push(createdAt, id);
  }
  params.push(opts.limit + 1);
  const { rows } = await tenantScopedQuery<OutcomeRow>(
    pool,
    tenantCtx,
    `SELECT * FROM session_outcomes
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT $${++n}`,
    params,
  );
  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  const nextCursor =
    hasMore && page.length > 0
      ? Buffer.from(
          JSON.stringify({
            createdAt: iso(page[page.length - 1].created_at),
            id: page[page.length - 1].id,
          }),
          "utf8",
        ).toString("base64url")
      : null;
  return { data: page.map(toOutcome), nextCursor };
}

// ---------------------------------------------------------------------------
// Cancel + stale expiry (R6.3)
// ---------------------------------------------------------------------------

/**
 * Cancel a non-terminal outcome (R6.3): persist `interrupted` (§16.5 taxonomy) so the
 * session stops being 409-blocked. Idempotent — cancelling an already-terminal outcome
 * returns it unchanged. The in-process loop (if any) is aborted separately through
 * `cancelOutcomeRun` (runner.ts); the abort makes the loop finalize the same terminal
 * status, so a double write is a no-op.
 */
export async function cancelOutcome(
  pool: Pool,
  tenantCtx: TenantCtx,
  sessionId: string,
  outcomeId: string,
): Promise<Outcome> {
  const row = await fetchOutcomeRow(pool, tenantCtx, outcomeId);
  if (!row || row.session_id !== sessionId) {
    throw new ApiError(404, "not_found", `outcome not found: ${outcomeId}`);
  }
  if (!ACTIVE_STATUSES.has(row.status as OutcomeStatus)) {
    return toOutcome(row); // already terminal — idempotent
  }
  return updateOutcomeStatus(pool, tenantCtx, outcomeId, {
    status: "interrupted",
    result: "interrupted",
    iteration: row.iteration,
  });
}

/**
 * Expire outcomes stuck non-terminal past the loop's wall-clock cap (R6.3). An outcome
 * whose loop was never started (no runner wired), or whose owning process died mid-loop,
 * would otherwise stay `active` forever and block the session's one-at-a-time slot
 * (§16.5). Such rows land `failed` — the §16.5 result for "could not be evaluated".
 *
 * The cap comes from {@link outcomeTimeoutMs} (`OUTCOME_TIMEOUT_MS`, default 30 min): a
 * live loop aborts itself at the same deadline, so this never reaps a healthy run.
 * Returns the number of rows expired.
 */
export async function expireStaleOutcomes(
  pool: Pool,
  tenantCtx: TenantCtx,
  sessionId: string,
  timeoutMs: number = outcomeTimeoutMs(),
): Promise<number> {
  if (timeoutMs <= 0) return 0;
  // The cutoff uses the DB clock (`now()`), not the app's — `created_at` is written by
  // the DB, and the two clocks can skew.
  const { rows } = await tenantScopedQuery<OutcomeRow>(
    pool,
    tenantCtx,
    `UPDATE session_outcomes
        SET status = 'failed', result = 'failed'
      WHERE tenant_id = $1
        AND session_id = $2
        AND status = ANY($3::text[])
        AND created_at < now() - make_interval(secs => $4::double precision)
      RETURNING *`,
    [tenantCtx.tenantId, sessionId, [...ACTIVE_STATUSES], timeoutMs / 1000],
  );
  return rows.length;
}

// ---------------------------------------------------------------------------
// Internal accessors (used by the iteration loop)
// ---------------------------------------------------------------------------

/** Fetch the active (non-terminal) outcome row for a session, or null. */
export async function fetchActiveOutcomeRow(
  pool: Pool,
  tenantCtx: TenantCtx,
  sessionId: string,
): Promise<OutcomeRow | null> {
  const { rows } = await tenantScopedQuery<OutcomeRow>(
    pool,
    tenantCtx,
    `SELECT * FROM session_outcomes
      WHERE tenant_id = $1 AND session_id = $2 AND status = ANY($3::text[])`,
    [tenantCtx.tenantId, sessionId, [...ACTIVE_STATUSES]],
  );
  return rows[0] ?? null;
}

/** Fetch a single outcome row (internal). */
export async function fetchOutcomeRow(
  pool: Pool,
  tenantCtx: TenantCtx,
  outcomeId: string,
): Promise<OutcomeRow | null> {
  const { rows } = await tenantScopedQuery<OutcomeRow>(
    pool,
    tenantCtx,
    `SELECT * FROM session_outcomes WHERE tenant_id = $1 AND id = $2`,
    [tenantCtx.tenantId, outcomeId],
  );
  return rows[0] ?? null;
}

/**
 * Persist an outcome's status / result / iteration. Used by the iteration loop to
 * record each transition (§16.5). Returns the updated wire resource.
 */
export async function updateOutcomeStatus(
  pool: Pool,
  tenantCtx: TenantCtx,
  outcomeId: string,
  update: { status: OutcomeStatus; result?: OutcomeResult; iteration: number },
): Promise<Outcome> {
  const { rows } = await tenantScopedQuery<OutcomeRow>(
    pool,
    tenantCtx,
    `UPDATE session_outcomes
        SET status = $3, result = $4, iteration = $5
      WHERE tenant_id = $1 AND id = $2
      RETURNING *`,
    [
      tenantCtx.tenantId,
      outcomeId,
      update.status,
      update.result ?? null,
      update.iteration,
    ],
  );
  if (!rows[0]) {
    throw new ApiError(404, "not_found", `outcome not found: ${outcomeId}`);
  }
  return toOutcome(rows[0]);
}
