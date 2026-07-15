/**
 * Credential service (WP-1.9, §12.1, §12.4, §3.5 `vault_credentials`).
 *
 * Phase-1 categories: `static_bearer` and `environment_variable`.
 * `mcp_oauth` is rejected as Phase 2 (§12.3 refresh). Secrets are encrypted at
 * rest with AES-256-GCM (see `crypto.ts`) and the sensitive fields
 * (`token`, `secretValue`, `accessToken`, `clientSecret`, `refreshToken`) are
 * WRITE-ONLY — never selected or returned (§12.4; enforced by contracts + a
 * serialization test).
 *
 * The credential `key` is `mcpServerUrl` for MCP creds, `secretName` for
 * env-var creds (§12.1) — immutable; to change, archive and create a new.
 */

import {
  tenantScopedQuery,
  type Pool,
  type TenantCtx,
} from "../../infra/db/index.js";
import { newId } from "../tenant/ids.js";
import { ApiError } from "../errors.js";
import { getVault } from "./vault.js";
import { reserveQuota, releaseQuota } from "../quota/index.js";
import type { VaultCrypto } from "./crypto.js";
import type { Credential, CredentialCreate } from "@pi-managed/contracts";
import type { McpOAuthRefreshConfig, McpOAuthSecretPayload } from "./refresh.js";

/** Max active credentials per vault (§12.4). */
export const MAX_CREDENTIALS_PER_VAULT = 20;

/** pg unique-violation error code (23505). */
function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code?: unknown }).code === "23505"
  );
}

/** Row shape selected from `vault_credentials` (never includes secret_enc). */
type CredentialDbRow = {
  id: string;
  vaultId: string;
  key: string;
  category: string;
  status: string;
  createdAt: Date;
};

/** SELECT projection — deliberately omits `secret_enc`, `nonce`, `key_id`. */
const CRED_COLS = `id, vault_id AS "vaultId", key, category, status, created_at AS "createdAt"`;

/**
 * Extract the plaintext secret from a create request (category-dependent).
 *
 * For `static_bearer`/`environment_variable` the secret is the raw token/value.
 * For `mcp_oauth` the secret is a JSON blob (§12.3): the access token, the
 * optional refresh token, and the optional client secret — so refresh can
 * exchange the token later without re-prompting. The blob is encrypted whole.
 */
function plaintextForCreate(input: CredentialCreate): string {
  switch (input.category) {
    case "static_bearer":
      return input.token;
    case "environment_variable":
      return input.secretValue;
    case "model_provider_key":
      return input.apiKey;
    case "mcp_oauth": {
      const payload: McpOAuthSecretPayload = {
        accessToken: input.accessToken,
        ...(input.refreshToken ? { refreshToken: input.refreshToken } : {}),
        ...(input.refresh ? { clientSecret: input.refresh.clientSecret } : {}),
      };
      return JSON.stringify(payload);
    }
  }
}

/**
 * Build the non-sensitive `metadata` for a credential (§3.5). For `mcp_oauth`,
 * stores the refresh config WITHOUT the client secret (which lives encrypted).
 */
function metadataForCreate(input: CredentialCreate): string {
  if (input.category === "mcp_oauth" && input.refresh) {
    const refresh: McpOAuthRefreshConfig = {
      method: input.refresh.method,
      tokenUrl: input.refresh.tokenUrl,
      clientId: input.refresh.clientId,
    };
    return JSON.stringify({ refresh });
  }
  return JSON.stringify({});
}

/**
 * Add a credential to `vaultId`. Validates the category, the vault (must exist
 * & be active), the per-vault max (20 → 422), and the unique `(vault, key)`
 * constraint (409 on duplicate). Encrypts the secret before persistence; returns
 * only non-sensitive fields. `mcp_oauth` is supported in Phase 2 (§12.3 refresh).
 */
export async function addCredential(
  pool: Pool,
  tenantCtx: TenantCtx,
  crypto: VaultCrypto,
  vaultId: string,
  input: CredentialCreate,
): Promise<Credential> {
  // Vault must exist and be active (getVault throws 404 if absent).
  const vault = await getVault(pool, tenantCtx, vaultId);
  if (vault.status === "archived") {
    throw new ApiError(409, "resource_archived", `vault is archived: ${vaultId}`);
  }

  // Enforce the per-vault cap on ACTIVE credentials (§12.4).
  const countRes = await tenantScopedQuery<{ n: number }>(
    pool,
    tenantCtx,
    `SELECT count(*)::int AS n
       FROM vault_credentials
      WHERE tenant_id = $1 AND vault_id = $2 AND status = 'active'`,
    [tenantCtx.tenantId, vaultId],
  );
  if ((countRes.rows[0]?.n ?? 0) >= MAX_CREDENTIALS_PER_VAULT) {
    throw new ApiError(
      422,
      "invalid_request",
      `vault has reached the ${MAX_CREDENTIALS_PER_VAULT}-credential limit`,
    );
  }

  const enc = crypto.encrypt(plaintextForCreate(input));
  const id = newId("vcred_");
  const metadata = metadataForCreate(input);

  // Transactional per-tenant credential quota (R5.2): reserve one slot atomically
  // (429 if over the plan limit — a dimension distinct from the per-vault cap
  // above), then insert. Release the slot if the insert fails so a rejected
  // create never leaks a reservation.
  await reserveQuota(pool, tenantCtx, "maxVaultCredentials");
  try {
    const { rows } = await tenantScopedQuery<CredentialDbRow>(
      pool,
      tenantCtx,
      `INSERT INTO vault_credentials
         (tenant_id, vault_id, id, key, category, secret_enc, key_id, nonce, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${CRED_COLS}`,
      [
        tenantCtx.tenantId,
        vaultId,
        id,
        input.key,
        input.category,
        enc.ciphertext,
        enc.keyId,
        enc.nonce,
        metadata,
      ],
    );
    return toCredential(rows[0]);
  } catch (e) {
    await releaseQuota(pool, tenantCtx, "maxVaultCredentials").catch(() => {});
    if (isUniqueViolation(e)) {
      throw new ApiError(
        409,
        "conflict",
        `credential key already exists in vault: ${input.key}`,
      );
    }
    throw e;
  }
}

/** List credentials for a vault (newest first; WITHOUT sensitive fields). */
export async function listCredentials(
  pool: Pool,
  tenantCtx: TenantCtx,
  vaultId: string,
): Promise<Credential[]> {
  // Confirm the vault exists (404 if absent) before listing its credentials.
  await getVault(pool, tenantCtx, vaultId);
  const { rows } = await tenantScopedQuery<CredentialDbRow>(
    pool,
    tenantCtx,
    `SELECT ${CRED_COLS}
       FROM vault_credentials
      WHERE tenant_id = $1 AND vault_id = $2
      ORDER BY created_at DESC`,
    [tenantCtx.tenantId, vaultId],
  );
  return rows.map(toCredential);
}

/**
 * Archive a credential (§12.7): purges `secret_enc`/`nonce`/`key_id`, sets
 * `status = 'archived'`. The key remains visible in the retained row.
 * Idempotent — archiving an already-archived credential returns it as-is.
 *
 * Archiving a live credential frees its `maxVaultCredentials` quota slot (R5.2
 * counter decrement). Only released when this call performed the transition
 * (`rows[0]` present), not when a concurrent archive won the race or the
 * credential was already archived — otherwise the counter would under-count.
 *
 * NOTE: the `vault_credentials` unique index on `(vault_id, key)` is NOT
 * partial (migration 008), so an archived row still occupies its `(vault, key)`
 * slot. The spec's "freed for a replacement" (§12.7) therefore requires a
 * partial unique index migration, which is outside this WP's owned paths. See
 * the report's open questions.
 */
export async function archiveCredential(
  pool: Pool,
  tenantCtx: TenantCtx,
  vaultId: string,
  key: string,
): Promise<{ id: string; status: string }> {
  const { rows } = await tenantScopedQuery<{ id: string }>(
    pool,
    tenantCtx,
    `UPDATE vault_credentials
        SET status = 'archived', secret_enc = NULL, key_id = NULL, nonce = NULL,
            updated_at = now()
      WHERE tenant_id = $1 AND vault_id = $2 AND key = $3 AND status = 'active'
     RETURNING id`,
    [tenantCtx.tenantId, vaultId, key],
  );
  if (rows[0]) {
    await releaseQuota(pool, tenantCtx, "maxVaultCredentials").catch(() => {});
    return { id: rows[0].id, status: "archived" };
  }
  // No active row updated: 404 if the key is entirely absent; else idempotent.
  const existing = await tenantScopedQuery<{ id: string }>(
    pool,
    tenantCtx,
    `SELECT id FROM vault_credentials
      WHERE tenant_id = $1 AND vault_id = $2 AND key = $3`,
    [tenantCtx.tenantId, vaultId, key],
  );
  if (!existing.rows[0]) {
    throw new ApiError(404, "not_found", `credential not found: ${key}`);
  }
  return { id: existing.rows[0].id, status: "archived" };
}

// (Phase-1 `validateCredential` 501 stub removed — the real implementation lives in
// `./validate.js` and is re-exported via `index.ts`; the route wires it directly.)

/** Map a DB row to the `Credential` contract shape (no sensitive fields). */
function toCredential(r: CredentialDbRow): Credential {
  return {
    id: r.id,
    vaultId: r.vaultId,
    key: r.key,
    category: r.category as Credential["category"],
    status: r.status as Credential["status"],
    createdAt: r.createdAt.toISOString(),
  };
}
