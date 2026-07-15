/**
 * Model-provider key resolver (§4.2, R2.7).
 *
 * Resolves a session's `model_provider_key` vault credentials into a
 * `providerId → apiKey` map decrypted host-side, for injection into the per-session
 * in-memory `AuthStorage`. This is the ONE place a raw model-provider key is
 * decrypted in the control plane; the value never reaches the sandbox and is never
 * logged or returned by the API.
 *
 * The credential `key` is the Pi provider id (e.g. "openai"); the encrypted
 * `secret_enc` payload is the API key (see `credential.ts` `plaintextForCreate`).
 *
 * Rotation/archival propagate automatically — this reads the live rows each wake, so
 * the next session reflects any change without a restart. Fail-closed enforcement
 * (throw when the session's model has no resolved key) lives at the materializer
 * (`session-manager/materialize.ts`), not here: this resolver only reports what exists.
 */

import { tenantScopedQuery, type Pool } from "../../infra/db/index.js";
import type { ProviderKeyResolver, SessionContext } from "../ports.js";
import type { VaultCrypto } from "./crypto.js";
import { getDefaultVaultCrypto } from "./crypto.js";

/** Options for {@link createProviderKeyResolver}. */
export interface ProviderKeyResolverOptions {
  /** Crypto used to decrypt the key payloads. Defaults to {@link getDefaultVaultCrypto}. */
  crypto?: VaultCrypto;
}

/**
 * Build a {@link ProviderKeyResolver} backed by `pool`. Selects active
 * `model_provider_key` credentials in the session's vaults, decrypts each, and
 * returns a `providerId → apiKey` map. A credential that fails to decrypt is skipped
 * (the fail-closed model-key check downstream will refuse the session if its provider
 * ends up unresolved).
 */
export function createProviderKeyResolver(
  pool: Pool,
  opts: ProviderKeyResolverOptions = {},
): ProviderKeyResolver {
  return {
    async resolveProviderKeys(
      ctx: SessionContext,
    ): Promise<Record<string, string>> {
      if (ctx.vaultIds.length === 0) return {};

      type KeyRow = {
        key: string;
        secretEnc: Buffer;
        nonce: Buffer;
        keyId: string;
      };
      const { rows } = await tenantScopedQuery<KeyRow>(
        pool,
        { tenantId: ctx.tenantId },
        `SELECT c.key,
                c.secret_enc AS "secretEnc", c.nonce, c.key_id AS "keyId"
           FROM vault_credentials c
           JOIN vaults v ON v.id = c.vault_id
          WHERE c.tenant_id = $1
            AND v.tenant_id = $1
            AND c.vault_id = ANY($2::text[])
            AND c.category = 'model_provider_key'
            AND c.status = 'active'
            AND v.status = 'active'
            AND c.secret_enc IS NOT NULL`,
        [ctx.tenantId, ctx.vaultIds],
      );

      const crypto = opts.crypto ?? getDefaultVaultCrypto();
      const keys: Record<string, string> = {};
      for (const r of rows) {
        try {
          keys[r.key] = crypto.decrypt({
            ciphertext: r.secretEnc,
            nonce: r.nonce,
            keyId: r.keyId,
          });
        } catch {
          // Undecryptable (e.g. rotated key) — skip; the model-key fail-closed guard
          // downstream refuses the session if its provider stays unresolved.
        }
      }
      return keys;
    },
  };
}
