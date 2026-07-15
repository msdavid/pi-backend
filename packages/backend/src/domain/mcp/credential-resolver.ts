/**
 * Vault-backed MCP credential resolver (§25.3, R2.5 mcp-bridge wiring).
 *
 * Implements the {@link McpCredentialResolver} the {@link McpCredentialProxy} depends on:
 * given a binding's opaque {@link SecretCredentialRef}, it decrypts the credential
 * host-side and returns the bearer token to inject into the MCP request. The token lives
 * only inside the proxy's `authorize` call; it is never returned to the harness, never
 * logged, and never enters the sandbox (§25.3 / §25.5).
 *
 * - `static_bearer` — the decrypted plaintext IS the bearer token.
 * - `mcp_oauth` — the decrypted plaintext is a JSON payload (`{accessToken,…}`,
 *   see `vault/refresh.ts`); the access token is returned. `SecretStore.revalidate`
 *   keeps the stored `accessToken` fresh (§12.5), so this reads the live value.
 * - `environment_variable` / anything else — not an MCP credential; returns `null`.
 *
 * Returns `null` when the credential is absent, archived, undecryptable, or empty.
 * For a binding the proxy has already matched by URL, that `null` is treated as
 * "configured but unresolvable" and the proxy **fails closed** — it refuses the call
 * (throws `McpAuthError`) rather than egressing unauthenticated (§19.6, SEC-7), and
 * the bridge reports the failure via `session.error`.
 */

import { tenantScopedQuery, type Pool } from "../../infra/db/index.js";
import type { SecretBinding } from "../ports.js";
import type { VaultCrypto } from "../vault/crypto.js";
import { getDefaultVaultCrypto } from "../vault/crypto.js";
import type { McpCredentialResolver } from "./proxy.js";
import type { McpOAuthSecretPayload } from "../vault/refresh.js";

/** Options for {@link createVaultMcpCredentialResolver}. */
export interface VaultMcpCredentialResolverOptions {
  /** Crypto used to decrypt `secret_enc`. Defaults to {@link getDefaultVaultCrypto}. */
  crypto?: VaultCrypto;
}

/**
 * Build an {@link McpCredentialResolver} backed by `pool`. Resolves a binding ref to its
 * live bearer token host-side. Constructed once by the composition root and shared across
 * sessions (it is stateless aside from the pool + crypto).
 */
export function createVaultMcpCredentialResolver(
  pool: Pool,
  opts: VaultMcpCredentialResolverOptions = {},
): McpCredentialResolver {
  return {
    async resolveToken(
      ref: SecretBinding["credentialRef"],
    ): Promise<string | null> {
      type CredRow = {
        category: string;
        secretEnc: Buffer | null;
        nonce: Buffer | null;
        keyId: string | null;
      };
      const { rows } = await tenantScopedQuery<CredRow>(
        pool,
        { tenantId: ref.tenantId },
        `SELECT c.category, c.secret_enc AS "secretEnc", c.nonce, c.key_id AS "keyId"
           FROM vault_credentials c
           JOIN vaults v ON v.id = c.vault_id
          WHERE c.tenant_id = $1
            AND v.tenant_id = $1
            AND c.vault_id = $2
            AND c.key = $3
            AND c.status = 'active'
            AND v.status = 'active'
          LIMIT 1`,
        [ref.tenantId, ref.vaultId, ref.credentialKey],
      );

      const row = rows[0];
      if (!row || !row.secretEnc || !row.nonce || !row.keyId) return null;

      const crypto = opts.crypto ?? getDefaultVaultCrypto();
      let plaintext: string;
      try {
        plaintext = crypto.decrypt({
          ciphertext: row.secretEnc,
          nonce: row.nonce,
          keyId: row.keyId,
        });
      } catch {
        return null; // undecryptable (e.g. rotated key) — proxy fails closed (SEC-7).
      }

      if (row.category === "mcp_oauth") {
        try {
          const payload = JSON.parse(plaintext) as McpOAuthSecretPayload;
          return payload.accessToken ?? null;
        } catch {
          return null;
        }
      }
      if (row.category === "static_bearer") {
        return plaintext;
      }
      // Not an MCP credential category.
      return null;
    },
  };
}
