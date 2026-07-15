/**
 * Host-side vault secret resolver (§25.5, R2.4).
 *
 * Implements the {@link SecretResolver} the {@link MicrosandboxProvider} depends on
 * (see `infra/sandbox/provider.ts`): given an opaque {@link SecretCredentialRef} +
 * category, it decrypts the credential's `secret_enc` **host-side** via
 * {@link VaultCrypto} and returns the raw value the msb SDK's secret mechanism needs.
 *
 * This is the ONE place a sandbox credential's raw value is read in the control plane
 * (the sibling `provider-keys.ts` is the equivalent for model-provider keys). The value
 * never crosses back through the port surface: the provider hands it straight to the msb
 * secret binding, and the guest sees only the `$MSB_<VAR>` placeholder. The value is
 * NEVER logged and NEVER returned by the API.
 *
 * - `environment_variable` — the placeholder's value is the decrypted secret; egress
 *   `allowedHosts` come from the credential metadata (empty today — egress substitution
 *   requires TLS interception, §30 item 14 OPEN — so the binding is registered with no
 *   host restriction and substitution is a no-op until that lands).
 * - `git_token` (§25.2) — a repo mount's PAT. Stored as an ordinary `environment_variable`
 *   credential (the row this resolves is identical); what differs is the BINDING: it
 *   carries `allowedHosts: [<git host>]`, compiled from the repo URL by
 *   `compileGitTokenBindings`, and the provider unions that with whatever this resolver
 *   returns. The resolver deliberately adds no hosts of its own — the repo mount, not the
 *   credential, decides where the token may be sent.
 * - `static_bearer` / `mcp_oauth` — the provider never resolves these here (the MCP proxy
 *   injects them, §25.3); the method still decrypts on demand for completeness so a caller
 *   that does route an MCP category through the provider gets the live token, not a throw.
 */

import { tenantScopedQuery, type Pool } from "../../infra/db/index.js";
import type { SecretCredentialRef, SecretCategory } from "../ports.js";
import type { SecretResolver } from "../../infra/sandbox/provider.js";
import type { VaultCrypto } from "./crypto.js";
import { getDefaultVaultCrypto } from "./crypto.js";

/** Options for {@link createVaultSecretResolver}. */
export interface VaultSecretResolverOptions {
  /** Crypto used to decrypt `secret_enc`. Defaults to {@link getDefaultVaultCrypto}. */
  crypto?: VaultCrypto;
}

/**
 * Build a {@link SecretResolver} backed by `pool`. Resolves an opaque credential ref
 * to its decrypted value host-side. Throws when the credential cannot be found or
 * decrypted — a binding that references a missing/rotated credential must fail the
 * provision loudly rather than silently omit the secret.
 */
export function createVaultSecretResolver(
  pool: Pool,
  opts: VaultSecretResolverOptions = {},
): SecretResolver {
  return {
    async resolve(
      ref: SecretCredentialRef,
      _category: SecretCategory,
      _mcpServerUrl?: string,
    ): Promise<{ value: string; allowedHosts: string[] }> {
      type CredRow = {
        secretEnc: Buffer | null;
        nonce: Buffer | null;
        keyId: string | null;
      };
      const { rows } = await tenantScopedQuery<CredRow>(
        pool,
        { tenantId: ref.tenantId },
        `SELECT c.secret_enc AS "secretEnc", c.nonce, c.key_id AS "keyId"
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
      if (!row || !row.secretEnc || !row.nonce || !row.keyId) {
        throw new Error(
          `VaultSecretResolver: no active credential for vault ${ref.vaultId} / key ` +
            `"${ref.credentialKey}" (§25.5)`,
        );
      }

      const crypto = opts.crypto ?? getDefaultVaultCrypto();
      const value = crypto.decrypt({
        ciphertext: row.secretEnc,
        nonce: row.nonce,
        keyId: row.keyId,
      });

      // Egress substitution (§25.4) requires TLS interception (§30 item 14 — OPEN):
      // no per-credential host allow-list is stored yet, so the binding registers
      // with no host restriction.
      return { value, allowedHosts: [] };
    },
  };
}
