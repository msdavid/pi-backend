/**
 * Session fork logic (WP-1.6, §6.3, §30 item 8).
 *
 * A fork is a **new session resource sharing the JSONL tree up to the fork
 * point** (Pi-native tree fork, NOT a copy — §30 item 8 resolved). The fork row
 * inherits the parent's agent (pinned version), environment, overrides, budget,
 * vault ids, resources, and metadata, and points its `jsonl_object_key` at the
 * SAME durable log object as the parent. New entries diverge from the fork point
 * (Pi branches append to the shared tree under a new branch id); the original
 * session's view is unaffected — edit-after-fork isolation.
 *
 * The fork is created `idle` with fresh (zero) usage; the parent's cumulative
 * usage is NOT carried over (a fork is a new resource). Returns the new session
 * with `forkedFromSessionId` set to the parent's id.
 */

import { type Pool, type TenantCtx } from "../../infra/db/index.js";
import { ApiError } from "../errors.js";
import { newId } from "../tenant/ids.js";
import { reserveQuota, releaseQuota } from "../quota/index.js";
import { fetchSessionRow, insertSessionRow, toSession } from "./session-repo.js";

/**
 * Fork `id` under `tenantCtx`. Returns the new `idle` session sharing the
 * parent's JSONL object key. `404` if the parent is absent / archived.
 */
export async function forkSession(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
) {
  const parent = await fetchSessionRow(pool, tenantCtx, id);
  if (!parent || parent.status === "archived") {
    throw new ApiError(404, "not_found", `session not found: ${id}`);
  }
  const forkId = newId("sess_");

  // A fork is a new session resource → it consumes a concurrent-session slot.
  // Reserve transactionally (429 if over limit), then insert; release on insert
  // failure so a rejected fork never leaks a reservation (R5.2).
  await reserveQuota(pool, tenantCtx, "concurrentSessions");
  let row;
  try {
    // Share the parent's jsonl_object_key — Pi-native tree fork (§30 item 8).
    row = await insertSessionRow(pool, tenantCtx, {
      id: forkId,
      agentId: parent.agent_id,
      agentVersion: parent.agent_version,
      environmentId: parent.environment_id,
      title: parent.title ? `${parent.title} (fork)` : undefined,
      budget: (parent.budget ?? undefined) as never,
      vaultIds: parent.vault_ids,
      resources: parent.resources,
      metadata: (parent.metadata ?? undefined) as never,
      jsonlObjectKey: parent.jsonl_object_key,
      agentOverrides: parent.agent_overrides,
      forkedFromSessionId: parent.id,
    });
  } catch (err) {
    await releaseQuota(pool, tenantCtx, "concurrentSessions").catch(() => {});
    throw err;
  }
  return toSession(row);
}
