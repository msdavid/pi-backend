/**
 * Session creation logic (WP-1.6, §6.3).
 *
 * The `agent` field has three wire forms (§6.3):
 *  1. bare ID            → pin the agent's latest (`current`) version;
 *  2. pinned version     → use the exact version (`404` if absent);
 *  3. overrides          → pin the latest version AND store per-session overrides
 *                           (omit→inherit, null→clear, value→full replace).
 *
 * Creation validates the agent (not archived — `isAgentArchived` → `422
 * resource_archived`) and environment (not archived → `422 resource_archived`),
 * then stores the session row in `idle` status with a fresh `jsonl_object_key`.
 * The sandbox is provisioned **lazily** — no `provision()` call happens here;
 * work starts on the first `user.message` event via the session manager (§6.3).
 *
 * NOTE on overrides parsing: contracts' `AgentOverrides` (`AgentConfig.partial()`)
 * does not permit `null`, but §6.3 specifies "set null → clear". To honor the
 * spec without modifying the shared contracts package, the overrides form is
 * parsed with a local loose schema (`overrides` as a record of unknown values,
 * nulls preserved) and stored verbatim in `agent_overrides`. The effective config
 * is resolved by {@link resolveEffectiveConfig} / `applyOverrides` at read time.
 */

import { z } from "zod";
import { type Pool, type TenantCtx } from "../../infra/db/index.js";
import { ApiError } from "../errors.js";
import { newId } from "../tenant/ids.js";
import { isAgentArchived, getAgent, getVersion } from "../agent/agent.js";
import { getEnvironment } from "../environment/environment.js";
import { reserveQuota, releaseQuota, checkQuota } from "../quota/index.js";
import { agentId, envId, Budget, Metadata } from "@pi-managed/contracts";
import { insertSessionRow, sessionJsonlObjectKey, toSession } from "./session-repo.js";

/**
 * Loose create schema — mirrors `SessionCreate` but accepts the overrides form
 * with `null` values (§6.3 null-clear), which the contracts `AgentOverrides`
 * schema rejects. Bare-ID and pinned forms reuse the contracts shapes directly.
 */
const PinnedAgentForm = z.object({ id: agentId, version: z.number().int().positive() });
const OverrideAgentForm = z.object({
  id: agentId,
  overrides: z.record(z.string(), z.unknown()),
});
const SessionCreateLoose = z.object({
  agent: z.union([agentId, PinnedAgentForm, OverrideAgentForm]),
  environmentId: envId,
  title: z.string().optional(),
  resources: z.array(z.string()).optional(),
  vaultIds: z.array(z.string().min(1)).optional(),
  budget: Budget.optional(),
  metadata: Metadata.optional(),
});

/** Resolved agent field: which form, which version, which overrides. */
interface ResolvedAgentField {
  agentId: string;
  /** Explicit pinned version (bare/overrides → undefined → use current). */
  version?: number;
  /** Per-session overrides blob (null for bare/pinned forms). */
  overrides?: Record<string, unknown> | null;
}

function resolveAgentField(raw: unknown): ResolvedAgentField {
  if (typeof raw === "string") return { agentId: raw };
  const obj = raw as { id: string; version?: number; overrides?: unknown };
  if (obj.version !== undefined) {
    return { agentId: obj.id, version: obj.version };
  }
  if (obj.overrides !== undefined) {
    return { agentId: obj.id, overrides: obj.overrides as Record<string, unknown> };
  }
  // {id} alone with neither version nor overrides → treat as bare latest.
  return { agentId: obj.id };
}

/**
 * Create a session under `tenantCtx`. Validates agent + environment, resolves
 * the agent version per the 3-form `agent` field, and stores an `idle` row with
 * a fresh JSONL object-store key. No sandbox provisioning (§6.3 lazy).
 */
export async function createSession(
  pool: Pool,
  tenantCtx: TenantCtx,
  input: unknown,
) {
  const parsed = SessionCreateLoose.safeParse(input);
  if (!parsed.success) {
    throw new ApiError(
      422,
      "invalid_request",
      `invalid session create: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  const data = parsed.data;
  const { agentId, version, overrides } = resolveAgentField(data.agent);

  // Agent existence (404 if absent) — getAgent expands currentVersion.
  const agent = await getAgent(pool, tenantCtx, agentId);
  // Archived agent → 422 resource_archived (§6.3).
  if (await isAgentArchived(pool, tenantCtx, agentId)) {
    throw new ApiError(422, "resource_archived", `agent is archived: ${agentId}`);
  }

  // Resolve the pinned agent version.
  let agentVersion: number;
  if (version !== undefined) {
    // Pinned: verify the exact version exists (getVersion throws 404 otherwise).
    await getVersion(pool, tenantCtx, agentId, version);
    agentVersion = version;
  } else {
    // Bare ID / overrides → latest (current) version.
    agentVersion = agent.currentVersion;
  }

  // Environment existence + archive check.
  const environment = await getEnvironment(pool, tenantCtx, data.environmentId);
  if (!environment) {
    throw new ApiError(404, "not_found", `environment not found: ${data.environmentId}`);
  }
  if (environment.status === "archived") {
    throw new ApiError(422, "resource_archived", `environment is archived: ${data.environmentId}`);
  }

  const id = newId("sess_");
  const jsonlObjectKey = sessionJsonlObjectKey(tenantCtx.tenantId, id);

  // Monthly token-spend admission gate (ROB-15): a tenant already over its monthly
  // spend cap cannot start new work. `checkQuota` reads the authoritative
  // `usage_records` rollup — spend accrues during execution and is never reserved
  // up front, so there is no reservation race to close here, only this admission gate.
  const spend = await checkQuota(pool, tenantCtx.tenantId, "monthlyTokenSpendUsd");
  if (spend.exceeded) {
    throw new ApiError(429, "rate_limited", "monthly token spend limit exceeded", {
      resource: spend.resource,
      limit: spend.limit,
      current: spend.current,
    });
  }

  // Transactional concurrent-session quota (R5.2): reserve one slot atomically
  // (429 if over limit), then insert. Release the slot if the insert fails so a
  // rejected create never leaks a reservation.
  await reserveQuota(pool, tenantCtx, "concurrentSessions");
  let row;
  try {
    row = await insertSessionRow(pool, tenantCtx, {
      id,
      agentId,
      agentVersion,
      environmentId: data.environmentId,
      title: data.title,
      budget: data.budget,
      vaultIds: data.vaultIds,
      resources: data.resources,
      metadata: data.metadata,
      jsonlObjectKey,
      agentOverrides: overrides ?? null,
      forkedFromSessionId: null,
    });
  } catch (err) {
    await releaseQuota(pool, tenantCtx, "concurrentSessions").catch(() => {});
    throw err;
  }
  return toSession(row);
}
