/**
 * Self-hosted worker keys (WP-4.1, §10.4).
 *
 * Environment-scoped API keys for workers. A worker key is scoped to a single
 * environment's work queue: it may `claim` items and post `user.tool_result`
 * results for that environment only. **Distinct from org keys** — org keys (a
 * regular tenant API key with no worker scope) are used for `work.stop`.
 *
 * Implementation: worker keys are stored in the existing `api_keys` table (reusing
 * the argon2id-hashed, shown-once issuance in {@link issueApiKey}) with a scope
 * marker `self_hosted_worker:<envId>`. The global bearer-auth middleware accepts
 * them like any tenant API key; the work-queue routes re-resolve the scope from
 * the bearer to enforce environment binding (and to distinguish org vs worker
 * keys for `work.stop`). This avoids edits to the shared auth middleware / api
 * key service (§27.1 — the worker key is still a tenant-scoped API key).
 */

import {
  query,
  type Pool,
  type TenantCtx,
} from "../../infra/db/index.js";
import { issueApiKey } from "../tenant/api-key.js";
import { ULID_PATTERN } from "../tenant/ids.js";
import { ApiError } from "../errors.js";

/** Scope marker format: `self_hosted_worker:<envId>`. */
export const WORKER_SCOPE_PREFIX = "self_hosted_worker:";

/**
 * Raw worker key format (reuses the api-key shape): `pmb_live_<ulid>_<secret>`.
 * The embedded ULID (26 chars) is the `apikey_…` id payload; the secret is 32
 * Crockford-Base32 chars. Used to re-derive the api-key id from a bearer.
 */
const KEY_REGEX = new RegExp(
  `^pmb_live_(${ULID_PATTERN})_[0-9A-HJKMNP-TV-Z]{32}$`,
);

/** A newly issued worker key — the ONLY response that includes the raw `key`. */
export interface IssuedWorkerKey {
  id: string;
  name: string;
  key: string;
  environmentId: string;
  createdAt: string;
}

/** A resolved worker key's binding (after re-reading its scope from `api_keys`). */
export interface ResolvedWorkerKey {
  apiKeyId: string;
  environmentId: string;
}

/**
 * Issue a worker key scoped to `environmentId` (called with an org/tenant API
 * key by a tenant admin). The raw `key` is shown once; only the argon2id hash is
 * stored (§8). Returns the worker key with its environment binding.
 */
export async function issueWorkerKey(
  pool: Pool,
  tenantCtx: TenantCtx,
  environmentId: string,
  name: string,
): Promise<IssuedWorkerKey> {
  const issued = await issueApiKey(pool, tenantCtx, {
    name,
    scopes: [`${WORKER_SCOPE_PREFIX}${environmentId}`],
  });
  return {
    id: issued.id,
    name: issued.name,
    key: issued.key,
    environmentId,
    createdAt: issued.createdAt,
  };
}

/**
 * Resolve a bearer token to its worker-key binding. Reads the `api_keys` row by
 * the ULID embedded in the raw key (O(1), no argon2 — the global auth middleware
 * has already verified the secret) and validates the scope marker.
 *
 * Returns `null` if the bearer is not a worker key (malformed, absent, revoked,
 * or lacking the `self_hosted_worker:<envId>` scope).
 */
export async function resolveWorkerKey(
  pool: Pool,
  tenantCtx: TenantCtx,
  bearer: string,
): Promise<ResolvedWorkerKey | null> {
  const match = KEY_REGEX.exec(bearer);
  if (!match) return null;
  const apiKeyId = `apikey_${match[1]}`;
  const { rows } = await query<{ scopes: string[]; revoked_at: Date | null }>(
    pool,
    `SELECT scopes, revoked_at FROM api_keys WHERE tenant_id = $1 AND id = $2`,
    [tenantCtx.tenantId, apiKeyId],
  );
  const row = rows[0];
  if (!row || row.revoked_at) return null;
  const scopes = Array.isArray(row.scopes) ? row.scopes : [];
  for (const s of scopes) {
    if (typeof s === "string" && s.startsWith(WORKER_SCOPE_PREFIX)) {
      return { apiKeyId, environmentId: s.slice(WORKER_SCOPE_PREFIX.length) };
    }
  }
  return null;
}

/**
 * Assert that the bearer is an **org key** (a regular tenant API key with NO
 * worker scope), used for `work.stop` (§10.4 — "auths with the org API key, not
 * the environment key"). Throws `403 forbidden` if the key carries a worker
 * scope (it's a worker key, not an org key). Returns `void` for org keys.
 *
 * This re-reads the `api_keys` row by the embedded ULID; the global auth
 * middleware has already verified the secret.
 */
export async function assertOrgKey(
  pool: Pool,
  tenantCtx: TenantCtx,
  bearer: string,
): Promise<void> {
  const worker = await resolveWorkerKey(pool, tenantCtx, bearer);
  if (worker) {
    throw new ApiError(
      403,
      "forbidden",
      "work.stop requires an org API key, not an environment worker key (§10.4)",
    );
  }
}

/**
 * Require a worker key scoped to `environmentId` for a work-queue route (claim /
 * post-result). Throws `403 forbidden` if the bearer is not a worker key, is
 * revoked, or is scoped to a different environment (§10.4 — "a worker key for
 * env A cannot claim env B's work"). Returns the resolved binding.
 */
export async function requireWorkerKeyForEnv(
  pool: Pool,
  tenantCtx: TenantCtx,
  bearer: string,
  environmentId: string,
): Promise<ResolvedWorkerKey> {
  const worker = await resolveWorkerKey(pool, tenantCtx, bearer);
  if (!worker) {
    throw new ApiError(
      403,
      "forbidden",
      "a worker key scoped to this environment is required",
    );
  }
  if (worker.environmentId !== environmentId) {
    throw new ApiError(
      403,
      "forbidden",
      `worker key is scoped to environment ${worker.environmentId}, not ${environmentId}`,
    );
  }
  return worker;
}
