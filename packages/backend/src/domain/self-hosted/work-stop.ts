/**
 * Self-hosted work.stop (WP-4.1, §10.4, §"POST /v1/environments/:id/work-stop").
 *
 * `stopWork(sessionId, {force})` asks the worker handling a self-hosted session
 * to shut it down cleanly; `force: true` interrupts immediately. The request
 * stamps `stop_requested` (`'clean'` | `'force'`) + `stop_requested_at` on the
 * work item — the worker observes the flag on its next claim/result cycle and
 * halts. `force` additionally transitions the item to `stopped` so no further
 * results are accepted.
 *
 * Auth: the **org** API key, NOT the environment worker key (§10.4). Docs warn
 * against setting the org key on the worker host. The route layer enforces this
 * via {@link assertOrgKey}; this domain function is key-type-agnostic.
 */

import {
  tenantScopedQuery,
  type Pool,
  type TenantCtx,
} from "../../infra/db/index.js";
import { ApiError } from "../errors.js";
import { fetchWorkItem, toWorkItem, type WorkItem, type WorkQueueRow } from "./work-queue.js";

/** `work.stop` request body (§10.4). */
export interface WorkStopInput {
  force?: boolean;
}

/**
 * Request a stop for the work item backing `sessionId`.
 *  - `force: false` (default): cooperative — stamps `stop_requested='clean'`;
 *    the worker finishes in-flight tool calls then halts.
 *  - `force: true`: immediate — stamps `stop_requested='force'` AND transitions
 *    the item to `stopped` (no further `user.tool_result` results accepted).
 *
 * Returns the updated work item, or `null` if no work item exists for the
 * session (absent / cross-tenant). Idempotent on an already-stopped item.
 */
export async function stopWork(
  pool: Pool,
  tenantCtx: TenantCtx,
  sessionId: string,
  input: WorkStopInput = {},
): Promise<WorkItem | null> {
  const force = input.force === true;
  const existing = await fetchWorkItem(pool, tenantCtx, sessionId);
  if (!existing) return null;
  if (existing.status === "stopped") return existing;
  if (force) {
    const { rows } = await tenantScopedQuery<WorkQueueRow>(
      pool,
      tenantCtx,
      `UPDATE self_hosted_work_queue
          SET status = 'stopped',
              stop_requested = 'force',
              stop_requested_at = now(),
              completed_at = now(),
              updated_at = now()
        WHERE tenant_id = $1 AND session_id = $2
        RETURNING *`,
      [tenantCtx.tenantId, sessionId],
    );
    return rows[0] ? toWorkItem(rows[0]) : null;
  }
  const { rows } = await tenantScopedQuery<WorkQueueRow>(
    pool,
    tenantCtx,
    `UPDATE self_hosted_work_queue
        SET stop_requested = 'clean',
            stop_requested_at = now(),
            updated_at = now()
      WHERE tenant_id = $1 AND session_id = $2 AND status <> 'stopped'
      RETURNING *`,
    [tenantCtx.tenantId, sessionId],
  );
  if (!rows[0]) {
    throw new ApiError(
      409,
      "conflict",
      `work item for session ${sessionId} cannot be stopped (status: ${existing.status})`,
    );
  }
  return toWorkItem(rows[0]);
}
