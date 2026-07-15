/**
 * Vault service (WP-1.9, §8.5, §12, §3.5 `vaults`).
 *
 * CRUD over tenant-scoped vaults. Uses {@link tenantScopedQuery} so every
 * query is structurally scoped to `tenant_id` (§27.1). Archive cascades to all
 * credentials (secrets purged, records retained for audit, §12.7).
 *
 * NOTE (contradiction): the `VaultCreate`/`Vault` contracts carry an optional
 * `metadata` field, but the `vaults` table (migration 007) has no `metadata`
 * column. Adding one is outside this WP's owned paths (migrations are shared
 * schema), so `metadata` is accepted on create and currently ignored; responses
 * omit it (valid — it is optional). See open questions in the WP report.
 */

import {
  tenantScopedQuery,
  type Pool,
  type TenantCtx,
} from "../../infra/db/index.js";
import { newId } from "../tenant/ids.js";
import { ApiError } from "../errors.js";
import { releaseQuota } from "../quota/index.js";
import type { Vault, VaultCreate } from "@pi-managed/contracts";

/** Row shape selected from `vaults` (camelCased; matches the `Vault` contract). */
type VaultDbRow = {
  id: string;
  name: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

/** SELECT projection for vaults (no sensitive columns exist on this table). */
const VAULT_COLS = `id, name, status, created_at AS "createdAt", updated_at AS "updatedAt"`;

/** Create a vault. `409 conflict` on a duplicate `(tenant, name)`. */
export async function createVault(
  pool: Pool,
  tenantCtx: TenantCtx,
  input: VaultCreate,
): Promise<Vault> {
  const id = newId("vault_");
  const { rows } = await tenantScopedQuery<VaultDbRow>(
    pool,
    tenantCtx,
    `INSERT INTO vaults (tenant_id, id, name)
       VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, name) DO NOTHING
     RETURNING ${VAULT_COLS}`,
    [tenantCtx.tenantId, id, input.name],
  );
  if (rows.length === 0) {
    throw new ApiError(409, "conflict", `vault name already exists: ${input.name}`);
  }
  return toVault(rows[0]);
}

/** List all vaults for the tenant (newest first; includes archived for audit). */
export async function listVaults(
  pool: Pool,
  tenantCtx: TenantCtx,
): Promise<Vault[]> {
  const { rows } = await tenantScopedQuery<VaultDbRow>(
    pool,
    tenantCtx,
    `SELECT ${VAULT_COLS} FROM vaults
      WHERE tenant_id = $1
      ORDER BY created_at DESC`,
    [tenantCtx.tenantId],
  );
  return rows.map(toVault);
}

/** Fetch a single vault. `404 not_found` if absent (or in another tenant). */
export async function getVault(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
): Promise<Vault> {
  const { rows } = await tenantScopedQuery<VaultDbRow>(
    pool,
    tenantCtx,
    `SELECT ${VAULT_COLS} FROM vaults
      WHERE tenant_id = $1 AND id = $2`,
    [tenantCtx.tenantId, id],
  );
  if (!rows[0]) {
    throw new ApiError(404, "not_found", `vault not found: ${id}`);
  }
  return toVault(rows[0]);
}

/** Like {@link getVault} but returns `null` instead of throwing (internal use). */
async function findVault(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
): Promise<VaultDbRow | null> {
  const { rows } = await tenantScopedQuery<VaultDbRow>(
    pool,
    tenantCtx,
    `SELECT ${VAULT_COLS} FROM vaults
      WHERE tenant_id = $1 AND id = $2`,
    [tenantCtx.tenantId, id],
  );
  return rows[0] ?? null;
}

/**
 * Hard-delete a vault (§12.7). Returns `204`. Vault credentials are deleted
 * first (their FK to `vaults(id)` has no `ON DELETE CASCADE`); the vault row is
 * then removed. `404 not_found` if absent.
 *
 * Deleting an active credential frees its `maxVaultCredentials` quota slot
 * (R5.2); an already-archived credential carries no live slot. `RETURNING
 * status` lets the release count reflect only the active ones actually removed
 * (this bulk delete is `deleteSession`'s counterpart for vault credentials — the
 * cascade is a second place credentials leave the active set besides
 * `archiveCredential`).
 */
export async function deleteVault(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
): Promise<void> {
  const { rows: deletedCredentials } = await tenantScopedQuery<{ status: string }>(
    pool,
    tenantCtx,
    `DELETE FROM vault_credentials
      WHERE tenant_id = $1 AND vault_id = $2
     RETURNING status`,
    [tenantCtx.tenantId, id],
  );
  const { rowCount } = await tenantScopedQuery(
    pool,
    tenantCtx,
    `DELETE FROM vaults WHERE tenant_id = $1 AND id = $2`,
    [tenantCtx.tenantId, id],
  );
  if ((rowCount ?? 0) === 0) {
    throw new ApiError(404, "not_found", `vault not found: ${id}`);
  }
  const activeDeleted = deletedCredentials.filter((r) => r.status === "active").length;
  for (let i = 0; i < activeDeleted; i++) {
    await releaseQuota(pool, tenantCtx, "maxVaultCredentials").catch(() => {});
  }
}

/**
 * Archive a vault (§12.7). Cascades: every active credential is archived and
 * its `secret_enc`/`nonce`/`key_id` purged (records retained for audit). The
 * vault itself moves to `status = 'archived'`. Idempotent — archiving an
 * already-archived vault returns it as-is.
 */
export async function archiveVault(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
): Promise<Vault> {
  // Cascade: purge all active credential secrets in this vault. Each archived
  // credential frees a maxVaultCredentials quota slot (R5.2, same accounting as
  // the single-credential path in archiveCredential); release exactly as many
  // as this call transitioned, regardless of the vault row's own transition
  // below — those credential rows are archived either way.
  const { rowCount: archivedCredentialCount } = await tenantScopedQuery(
    pool,
    tenantCtx,
    `UPDATE vault_credentials
        SET status = 'archived', secret_enc = NULL, key_id = NULL, nonce = NULL,
            updated_at = now()
      WHERE tenant_id = $1 AND vault_id = $2 AND status = 'active'`,
    [tenantCtx.tenantId, id],
  );
  for (let i = 0; i < (archivedCredentialCount ?? 0); i++) {
    await releaseQuota(pool, tenantCtx, "maxVaultCredentials").catch(() => {});
  }
  const { rows } = await tenantScopedQuery<VaultDbRow>(
    pool,
    tenantCtx,
    `UPDATE vaults
        SET status = 'archived', updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'active'
     RETURNING ${VAULT_COLS}`,
    [tenantCtx.tenantId, id],
  );
  if (rows[0]) return toVault(rows[0]);
  // No row updated: either absent or already archived.
  const existing = await findVault(pool, tenantCtx, id);
  if (!existing) {
    throw new ApiError(404, "not_found", `vault not found: ${id}`);
  }
  return toVault(existing);
}

/** Map a DB row to the `Vault` contract shape. */
function toVault(r: VaultDbRow): Vault {
  return {
    id: r.id,
    name: r.name,
    status: r.status as Vault["status"],
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
