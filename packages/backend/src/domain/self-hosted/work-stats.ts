/**
 * Self-hosted work-stats (WP-4.1, §10.4, §"GET /v1/environments/:id/work-stats").
 *
 * `getWorkStats(envId)` → `{depth, pending, oldestQueuedAt, workersPolling}`,
 * for liveness alerting (§10.4):
 *  - `depth`           — total items in the queue (queued + claimed, i.e. not
 *                        done/stopped); the full backlog the env owes a worker.
 *  - `pending`         — items still awaiting a claim (`status = 'queued'`).
 *  - `oldestQueuedAt`  — `queued_at` of the oldest pending item (null if empty).
 *  - `workersPolling`  — count of items currently `claimed` (a claimed item
 *                        means a worker is actively processing it; a proxy for
 *                        the number of live workers, §10.4).
 *
 * The environment must be `self_hosted`; a `cloud` env yields a 422 (the queue
 * does not apply).
 */

import {
  tenantScopedQuery,
  type Pool,
  type TenantCtx,
} from "../../infra/db/index.js";
import { ApiError } from "../errors.js";
import type { Environment, WorkStats } from "@pi-managed/contracts";
import { getEnvironment } from "../environment/environment.js";

/** Stats row returned by the aggregate query. */
interface StatsRow {
  depth: string;
  pending: string;
  oldest_queued_at: Date | null;
  workers_polling: string;
}

/**
 * Compute work-stats for `environmentId`. Returns zeros when the queue is empty.
 * Throws `422 invalid_request` if the environment is not `self_hosted`, and
 * `404 not_found` if the environment is absent / cross-tenant.
 */
export async function getWorkStats(
  pool: Pool,
  tenantCtx: TenantCtx,
  environmentId: string,
): Promise<WorkStats> {
  const env = await getEnvironment(pool, tenantCtx, environmentId);
  if (!env) {
    throw new ApiError(404, "not_found", `environment not found: ${environmentId}`);
  }
  assertSelfHosted(env);
  const { rows } = await tenantScopedQuery<StatsRow>(
    pool,
    tenantCtx,
    `SELECT
        COUNT(*) FILTER (WHERE status IN ('queued','claimed'))::text AS depth,
        COUNT(*) FILTER (WHERE status = 'queued')::text AS pending,
        MIN(queued_at) FILTER (WHERE status = 'queued') AS oldest_queued_at,
        COUNT(*) FILTER (WHERE status = 'claimed')::text AS workers_polling
       FROM self_hosted_work_queue
      WHERE tenant_id = $1 AND environment_id = $2`,
    [tenantCtx.tenantId, environmentId],
  );
  const r = rows[0] ?? {
    depth: "0",
    pending: "0",
    oldest_queued_at: null,
    workers_polling: "0",
  };
  return {
    depth: Number.parseInt(r.depth, 10) || 0,
    pending: Number.parseInt(r.pending, 10) || 0,
    oldestQueuedAt: r.oldest_queued_at ? r.oldest_queued_at.toISOString() : null,
    workersPolling: Number.parseInt(r.workers_polling, 10) || 0,
  };
}

/** Throw `422 invalid_request` unless `env` is a self-hosted environment. */
export function assertSelfHosted(env: Environment): void {
  if (env.type !== "self_hosted") {
    throw new ApiError(
      422,
      "invalid_request",
      `work-stats only applies to self_hosted environments (env ${env.id} is ${env.type})`,
    );
  }
}
