/**
 * Self-hosted unsupported-features matrix (WP-4.1, §10.4 / §13.7).
 *
 * Self-hosted environments reject:
 *  - **memory stores** (§13.7) — the subscriber stages files/repos themselves
 *    (passed via session `metadata`); cross-session memory volumes are not
 *    mounted on the worker host.
 *  - **env-var credentials** (§10.4) — `environment_variable` vault credentials
 *    are not injected into the worker host's environment; only `static_bearer`
 *    (and Phase-2 `mcp_oauth`) credentials are supported.
 *
 * Both are enforced with clear `422 invalid_request` errors. The check is a
 * no-op for `cloud` environments (the matrix only restricts `self_hosted`).
 *
 * NOTE: wiring this into the shared session-creation path
 * (`domain/session/create.ts`) requires editing a shared file (outside this WP's
 * owned paths). The enforcement logic + tests live here; the session-creation
 * route calls it where permitted by its owned surface.
 */

import {
  tenantScopedQuery,
  type Pool,
  type TenantCtx,
} from "../../infra/db/index.js";
import { ApiError } from "../errors.js";
import type { Environment } from "@pi-managed/contracts";

/** Inputs to the constraints check (what a session creation references). */
export interface SessionConstraintInput {
  /** Vault ids referenced by the session (`vaultIds`, §6.3). */
  vaultIds?: string[];
  /**
   * Memory store ids referenced by the session (§13). Session creation does not
   * take a top-level `memoryStoreIds` field today, but memory stores may be
   * referenced via `resources` (mem_ prefixed) or attached later — this accepts
   * an explicit list for direct enforcement.
   */
  memoryStoreIds?: string[];
  /** Session `resources` (files / repos / refs) — scanned for mem_ ids. */
  resources?: string[];
}

/** `mem_` prefix for memory-store ids (contracts `ids.ts`). */
const MEM_PREFIX = "mem_";

/**
 * Enforce the self-hosted unsupported-features matrix. Throws `422
 * invalid_request` if a self-hosted session references memory stores or env-var
 * credentials. No-op for `cloud` environments.
 */
export async function assertSelfHostedSessionConstraints(
  pool: Pool,
  tenantCtx: TenantCtx,
  env: Environment,
  input: SessionConstraintInput = {},
): Promise<void> {
  if (env.type !== "self_hosted") return;

  // --- Memory stores (§13.7): reject any mem_ reference. ----------------
  const memRefs = collectMemoryStoreRefs(input);
  if (memRefs.length > 0) {
    throw new ApiError(
      422,
      "invalid_request",
      "memory stores are not supported on self_hosted environments (§13.7); "
        + "the subscriber stages files/repos via session metadata",
      { memoryStoreIds: memRefs },
    );
  }

  // --- Env-var credentials (§10.4): reject environment_variable creds. ----
  const vaultIds = input.vaultIds ?? [];
  if (vaultIds.length > 0) {
    const { rows } = await tenantScopedQuery<{ key: string }>(
      pool,
      tenantCtx,
      `SELECT key FROM vault_credentials
        WHERE tenant_id = $1
          AND vault_id = ANY($2::text[])
          AND category = 'environment_variable'
          AND status = 'active'`,
      [tenantCtx.tenantId, vaultIds],
    );
    if (rows.length > 0) {
      throw new ApiError(
        422,
        "invalid_request",
        "environment_variable credentials are not supported on self_hosted "
          + "environments (§10.4); use static_bearer or mcp_oauth credentials",
        {
          vaultIds,
          offendingKeys: rows.map((r) => r.key),
        },
      );
    }
  }
}

/** Collect memory-store ids from `memoryStoreIds` + `resources` (mem_ prefixed). */
function collectMemoryStoreRefs(input: SessionConstraintInput): string[] {
  const refs = new Set<string>();
  for (const id of input.memoryStoreIds ?? []) {
    if (typeof id === "string" && id.startsWith(MEM_PREFIX)) refs.add(id);
  }
  for (const r of input.resources ?? []) {
    if (typeof r === "string" && r.startsWith(MEM_PREFIX)) refs.add(r);
  }
  return [...refs];
}

/**
 * Convenience: enforce the matrix given an environment id (loads the env first).
 * Throws `404 not_found` if the environment is absent / cross-tenant. Returns
 * the loaded environment for callers that need it.
 */
export async function assertSelfHostedConstraintsForEnv(
  pool: Pool,
  tenantCtx: TenantCtx,
  environmentId: string,
  input: SessionConstraintInput = {},
): Promise<Environment> {
  const { getEnvironment } = await import("../environment/environment.js");
  const env = await getEnvironment(pool, tenantCtx, environmentId);
  if (!env) {
    throw new ApiError(404, "not_found", `environment not found: ${environmentId}`);
  }
  await assertSelfHostedSessionConstraints(pool, tenantCtx, env, input);
  return env;
}
