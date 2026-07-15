/**
 * Credential validation (WP-2.4, §12.5).
 *
 * Probes a credential's grant against its remote endpoint and classifies it:
 *
 * - `valid`   — the grant is live (2xx from the probe).
 * - `invalid` — the grant is gone (401/403/404/410 → prompt re-auth). A 4xx
 *   that is unambiguously "credentials revoked" — NOT a transient rate-limit.
 * - `unknown` — transient (5xx, 429, network/DNS/timeout) or the category has no
 *   remote to probe (e.g. `environment_variable`). Retry later.
 *
 * For `static_bearer` and `mcp_oauth`: a HEAD request (falling back to GET on
 * 405) to the credential key (the `mcpServerUrl`, §12.1) carrying the decrypted
 * token as `Authorization: Bearer <token>`. For `mcp_oauth`, this probes the
 * resource server with the live access token; a 401/403 means the grant is
 * gone. The spec mentions a token/introspection endpoint, but no introspection
 * URL is stored (§3.5 metadata only carries the refresh config), so the MCP
 * server URL is used as the probe target.
 *
 * SECURITY: the decrypted token is used ONLY for the probe request and is never
 * logged or returned. Only the coarse taxonomy leaves this module.
 */

import type { Pool, TenantCtx } from "../../infra/db/index.js";
import { tenantScopedQuery } from "../../infra/db/index.js";
import { ApiError } from "../errors.js";
import type { VaultCrypto } from "./crypto.js";
import type { FetchImpl } from "./refresh.js";
import type { CredentialValidateResponse } from "@pi-managed/contracts";

/** Convenience alias for the validate taxonomy. */
export type CredentialValidation = CredentialValidateResponse;

/** Injectable fetch — defaults to global `fetch`. */
export type ValidateFetchImpl = FetchImpl;

/** The row needed to validate a credential (no secret material beyond enc). */
type ValidateRow = {
  category: string;
  key: string;
  secretEnc: Buffer | null;
  nonce: Buffer | null;
  keyId: string | null;
};

async function loadRow(
  pool: Pool,
  tenantCtx: TenantCtx,
  vaultId: string,
  key: string,
): Promise<ValidateRow | null> {
  const { rows } = await tenantScopedQuery<ValidateRow>(
    pool,
    tenantCtx,
    `SELECT category, key, secret_enc AS "secretEnc", nonce, key_id AS "keyId"
       FROM vault_credentials
      WHERE tenant_id = $1 AND vault_id = $2 AND key = $3`,
    [tenantCtx.tenantId, vaultId, key],
  );
  return rows[0] ?? null;
}

/** Classify an HTTP status (and any fetch failure) into the taxonomy. */
function classify(status: number | null, err: unknown | null): CredentialValidation {
  if (err) return "unknown"; // network/DNS/timeout — transient.
  if (status === null) return "unknown";
  if (status >= 200 && status < 300) return "valid";
  if (status === 401 || status === 403 || status === 404 || status === 410) {
    return "invalid";
  }
  if (status === 429 || status >= 500) return "unknown";
  // Other 4xx (e.g. 400 bad request from a malformed probe) → unknown; we
  // cannot conclude the grant is gone from a non-auth 4xx.
  return "unknown";
}

/** Fetch with a HEAD→GET fallback; returns the worst status seen or an error. */
async function probe(
  fetchImpl: ValidateFetchImpl,
  url: string,
  bearer: string,
): Promise<{ status: number | null; err: unknown | null }> {
  const headers = { authorization: `Bearer ${bearer}` };
  try {
    let res = await fetchImpl(url, {
      method: "HEAD",
      headers,
      redirect: "manual",
    });
    // Some servers reject HEAD with 405; retry as GET and use that status.
    if (res.status === 405 || res.status === 404) {
      res = await fetchImpl(url, { method: "GET", headers, redirect: "manual" });
    }
    return { status: res.status, err: null };
  } catch (e) {
    return { status: null, err: e };
  }
}

/**
 * Validate a credential's grant (§12.5). Returns the taxonomy; never throws on
 * remote failures (they map to `unknown`). Throws `ApiError` (404) only when the
 * credential row is absent or archived (a client error, not a validation result).
 */
export async function validateCredential(
  deps: {
    pool: Pool;
    tenantCtx: TenantCtx;
    crypto: VaultCrypto;
    vaultId: string;
    key: string;
  },
  opts: { fetchImpl?: ValidateFetchImpl } = {},
): Promise<CredentialValidation> {
  const { pool, tenantCtx, crypto, vaultId, key } = deps;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const row = await loadRow(pool, tenantCtx, vaultId, key);
  if (!row) {
    // R7.2: statically imported from the domain error module — the dynamic
    // import of the server module that used to dodge the domain→HTTP
    // import cycle is gone with the cycle itself.
    throw new ApiError(404, "not_found", `credential not found: ${key}`);
  }

  if (row.category === "environment_variable") {
    // No remote endpoint to probe for an env-var secret.
    return "unknown";
  }

  // static_bearer / mcp_oauth — probe the mcpServerUrl (the credential key).
  if (row.secretEnc === null || row.nonce === null || row.keyId === null) {
    // Archived/purged secret → grant is gone.
    return "invalid";
  }

  let token: string;
  try {
    const plaintext = crypto.decrypt({
      ciphertext: row.secretEnc,
      nonce: row.nonce,
      keyId: row.keyId,
    });
    if (row.category === "mcp_oauth") {
      // The mcp_oauth secret payload is JSON; extract the access token.
      token = (JSON.parse(plaintext) as { accessToken: string }).accessToken;
    } else {
      // static_bearer — the plaintext IS the token.
      token = plaintext;
    }
  } catch {
    // Decryption/tamper failure — cannot determine liveness.
    return "unknown";
  }

  if (!token) return "invalid";

  const { status, err } = await probe(fetchImpl, row.key, token);
  return classify(status, err);
}
