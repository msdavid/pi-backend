/**
 * `SecretStore` implementation (WP-1.9, §12, §25.1, §25.4, §25.5).
 *
 * Resolves a session's referenced vault credentials into opaque
 * {@link SecretBinding} refs the `SandboxProvider` registers host-side.
 *
 * §25.5 invariant: this store NEVER exposes raw secret values. It selects only
 * `key`/`category`/`vault_id` from `vault_credentials` — never `secret_enc` —
 * and returns placeholder names + credential refs. The provider resolves the
 * real values host-side; the harness never sees them.
 *
 * - `environment_variable` → `{placeholderName: '$MSB_<secretName>', …}`. The
 *   guest env carries the placeholder; substitution happens at the egress
 *   boundary (§25.4).
 * - `static_bearer` → a binding with `mcpServerUrl` set (the credential key is
 *   the server URL, §12.1). The backend MCP proxy (Phase 3) fetches the token
 *   via the `credentialRef` and injects it; the harness/sandbox never see it.
 * - `git_token` (§25.2) → a binding per `egress` repo mount of the session's environment,
 *   carrying `$MSB_GIT_TOKEN_<slug>` + the mount's vault credential ref + the repo's git
 *   host as the ONLY host the token may be substituted toward. These come from the
 *   ENVIRONMENT (`mount.auth`), not from `vaultIds`.
 * - `mcp_oauth` → a binding with `mcpServerUrl` set, like `static_bearer`; the
 *   MCP proxy injects the (refreshed) access token host-side. `revalidate`
 *   refreshes expired tokens in place (§12.5).
 *
 * `revalidate` (§12.5 rotation/re-resolution propagation) refreshes expired
 * `mcp_oauth` access tokens. Rotation/archival/deletion propagate automatically
 * — `resolveBindingsForSession` reads the live rows, so the next call reflects
 * any change without a restart. Propagation of a refreshed token into the live
 * sandbox is a Phase-3 SandboxProvider concern (`registerSecretBinding`).
 */

import {
  tenantScopedQuery,
  type Pool,
} from "../../infra/db/index.js";
import type {
  SessionContext,
  SecretBinding,
  SecretStore,
  WebhookSink,
} from "../ports.js";
import type { VaultCrypto } from "./crypto.js";
import { getDefaultVaultCrypto } from "./crypto.js";
import { refreshOAuthToken, type McpOAuthSecretPayload } from "./refresh.js";
import { compileGitTokenBindings } from "../environment/compile-spec.js";
import type { Mount } from "@pi-managed/contracts";

/** A resolved credential row (only non-sensitive columns). */
type ResolvedCred = {
  vaultId: string;
  key: string;
  category: string;
};

/** Options for {@link createVaultSecretStore}. */
export interface VaultSecretStoreOptions {
  /** Crypto used to decrypt mcp_oauth payloads during `revalidate`. Defaults to
   * the process-wide {@link getDefaultVaultCrypto} when first needed. */
  crypto?: VaultCrypto;
  /** Sink for `vault_credential.refresh_failed` events (§12.5). */
  webhookSink?: WebhookSink;
  /** Injectable clock (tests). */
  now?: () => Date;
}

/**
 * Build a {@link SecretStore} backed by `pool`. The store carries no crypto by
 * default — it never decrypts during binding resolution, only during
 * `revalidate` (which refreshes expired mcp_oauth tokens).
 */
export function createVaultSecretStore(
  pool: Pool,
  opts: VaultSecretStoreOptions = {},
): SecretStore {
  const now = opts.now ?? (() => new Date());

  return {
    async resolveBindingsForSession(
      ctx: SessionContext,
    ): Promise<SecretBinding[]> {
      const bindings: SecretBinding[] = [];
      // A session with NO vaults can still have git_token bindings (§25.2): a repo mount
      // names its own credential, so don't short-circuit before that pass.
      const rows =
        ctx.vaultIds.length === 0
          ? []
          : (
              await tenantScopedQuery<ResolvedCred>(
                pool,
                { tenantId: ctx.tenantId },
                `SELECT c.vault_id AS "vaultId", c.key, c.category
           FROM vault_credentials c
           JOIN vaults v ON v.id = c.vault_id
          WHERE c.tenant_id = $1
            AND v.tenant_id = $1
            AND c.vault_id = ANY($2::text[])
            AND c.status = 'active'
            AND v.status = 'active'`,
                [ctx.tenantId, ctx.vaultIds],
              )
            ).rows;

      for (const r of rows) {
        if (r.category === "environment_variable") {
          bindings.push({
            placeholderName: `$MSB_${r.key}`,
            category: "environment_variable",
            credentialRef: {
              tenantId: ctx.tenantId,
              vaultId: r.vaultId,
              credentialKey: r.key,
            },
          });
        } else if (r.category === "static_bearer" || r.category === "mcp_oauth") {
          // The MCP proxy (Phase 3) resolves the token via credentialRef.
          // mcpServerUrl is the credential key (§12.1). No secret value here.
          bindings.push({
            placeholderName: `$MSB_mcp_${r.key}`,
            category: r.category as SecretBinding["category"],
            credentialRef: {
              tenantId: ctx.tenantId,
              vaultId: r.vaultId,
              credentialKey: r.key,
            },
            mcpServerUrl: r.key,
          });
        }
      }

      // git_token bindings (§25.2, R6.8) — sourced from the session's ENVIRONMENT, not
      // from `vaultIds`: a repo mount names its own vault credential (`mount.auth`), so
      // the binding exists even when the session references no vault. Still tenant-scoped
      // and still value-free: only the placeholder + an opaque credential ref.
      bindings.push(...(await resolveGitTokenBindings(pool, ctx)));
      return bindings;
    },

    async revalidate(ctx: SessionContext): Promise<void> {
      if (ctx.vaultIds.length === 0) return;

      // Find active mcp_oauth credentials with a refresh config in the session's
      // vaults. Only these are refreshable; static_bearer/env-var creds have no
      // remote refresh and propagate via the live row read above.
      type OauthRow = {
        vaultId: string;
        key: string;
        secretEnc: Buffer;
        nonce: Buffer;
        keyId: string;
      };
      const { rows } = await tenantScopedQuery<OauthRow>(
        pool,
        { tenantId: ctx.tenantId },
        `SELECT c.vault_id AS "vaultId", c.key,
                c.secret_enc AS "secretEnc", c.nonce, c.key_id AS "keyId",
                c.metadata
           FROM vault_credentials c
           JOIN vaults v ON v.id = c.vault_id
          WHERE c.tenant_id = $1
            AND v.tenant_id = $1
            AND c.vault_id = ANY($2::text[])
            AND c.category = 'mcp_oauth'
            AND c.status = 'active'
            AND v.status = 'active'
            AND c.metadata ? 'refresh'
            AND c.secret_enc IS NOT NULL`,
        [ctx.tenantId, ctx.vaultIds],
      );

      const crypto = opts.crypto ?? getDefaultVaultCrypto();
      const nowMs = now().getTime();

      for (const r of rows) {
        let payload: McpOAuthSecretPayload;
        try {
          payload = JSON.parse(
            crypto.decrypt({
              ciphertext: r.secretEnc,
              nonce: r.nonce,
              keyId: r.keyId,
            }),
          ) as McpOAuthSecretPayload;
        } catch {
          // Cannot decrypt — nothing to refresh; skip (validate will report).
          continue;
        }
        // Refresh only when we know it's expired (§12.5). Unknown expiry is left
        // for `validate`/the MCP proxy to surface.
        if (!payload.expiresAt) continue;
        const expiresMs = Date.parse(payload.expiresAt);
        if (!Number.isFinite(expiresMs) || expiresMs > nowMs) continue;

        try {
          await refreshOAuthToken(
            {
              pool,
              tenantCtx: { tenantId: ctx.tenantId },
              crypto,
              locator: { vaultId: r.vaultId, key: r.key },
            },
            { webhookSink: opts.webhookSink, now: now() },
          );
        } catch {
          // refreshOAuthToken already emitted `vault_credential.refresh_failed`
          // (if a sink is wired). Swallow here so one credential's failure
          // doesn't abort revalidation of the rest.
        }
      }
    },
  };
}

/**
 * Resolve the `git_token` bindings for a session's repo mounts (§25.2, R6.8).
 *
 * Reads the session's environment mounts and compiles one binding per `egress` repo that
 * declares an `auth` ref. Each referenced credential is verified to be an **active
 * `environment_variable` credential in an active vault of the SAME tenant** before its
 * binding is emitted — a mount that points at another tenant's vault, an archived
 * credential, or a non-existent key yields no binding (fail closed), so the provider
 * never registers a placeholder it cannot resolve.
 *
 * §25.5: like every other path here, this selects no `secret_enc` and returns no value —
 * only placeholder names + opaque refs.
 */
async function resolveGitTokenBindings(
  pool: Pool,
  ctx: SessionContext,
): Promise<SecretBinding[]> {
  const { rows } = await tenantScopedQuery<{ mounts: Mount[] | null }>(
    pool,
    { tenantId: ctx.tenantId },
    `SELECT e.mounts
       FROM sessions s
       JOIN environments e ON e.id = s.environment_id
      WHERE s.tenant_id = $1
        AND e.tenant_id = $1
        AND s.id = $2
      LIMIT 1`,
    [ctx.tenantId, ctx.sessionId],
  );
  const mounts = rows[0]?.mounts;
  if (!mounts || mounts.length === 0) return [];

  const candidates = compileGitTokenBindings({ mounts }, ctx);
  if (candidates.length === 0) return [];

  // Verify every referenced PAT credential is live and tenant-owned (fail closed).
  const vaultIds = [...new Set(candidates.map((b) => b.credentialRef.vaultId))];
  const { rows: creds } = await tenantScopedQuery<{ vaultId: string; key: string }>(
    pool,
    { tenantId: ctx.tenantId },
    `SELECT c.vault_id AS "vaultId", c.key
       FROM vault_credentials c
       JOIN vaults v ON v.id = c.vault_id
      WHERE c.tenant_id = $1
        AND v.tenant_id = $1
        AND c.vault_id = ANY($2::text[])
        AND c.category = 'environment_variable'
        AND c.status = 'active'
        AND v.status = 'active'`,
    [ctx.tenantId, vaultIds],
  );
  const live = new Set(creds.map((c) => `${c.vaultId} ${c.key}`));
  return candidates.filter((b) =>
    live.has(`${b.credentialRef.vaultId} ${b.credentialRef.credentialKey}`),
  );
}
