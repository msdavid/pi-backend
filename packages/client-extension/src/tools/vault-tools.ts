/**
 * WP-2.6 — Agent-facing `remote_*` tools for vaults & credentials.
 *
 * Spec §24.6, §12. Vaults are collections of credentials (bearer tokens, env
 * vars, MCP OAuth) registered once on the backend and referenced by ID at
 * session creation — the sandbox never receives raw secrets from the client.
 *
 * SECURITY: sensitive fields (token, accessToken, refreshToken, clientSecret,
 * secretValue) are WRITE-ONLY. They flow into create requests and are NEVER
 * present in API responses. These tools never echo secrets in their output.
 */

import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CredentialCategory, CredentialCreate } from "@pi-managed/contracts";
import type { ManagedApiClient } from "../api-client.js";

/** Options injected from the extension entry point. */
export interface VaultToolsOptions {
  client: () => ManagedApiClient | null;
}

// ---------------------------------------------------------------------------
// Tool parameter schemas (TypeBox)
// ---------------------------------------------------------------------------

const VaultListParams = Type.Object({
  limit: Type.Optional(Type.Number({ description: "Page size (default 50, max 200)." })),
});

const VaultCreateParams = Type.Object({
  name: Type.String({ description: "Human-readable vault name (1–128 chars, unique within the tenant)." }),
});

const VaultAddCredentialParams = Type.Object({
  vaultId: Type.String({ description: "Vault ID to add the credential to (vault_…)." }),
  key: Type.String({ description: "Credential key: mcpServerUrl for static_bearer/mcp_oauth, or secretName for environment_variable. Immutable; to change, archive and create a new one." }),
  category: Type.String({ description: "Credential category: 'static_bearer', 'environment_variable', or 'mcp_oauth'." }),
  secret: Type.String({ description: "The secret value. For static_bearer this is the token; for environment_variable the secretValue; for mcp_oauth the accessToken. Write-only — never returned." }),
  refreshToken: Type.Optional(Type.String({ description: "mcp_oauth only: optional refresh token (stored encrypted, never returned)." })),
  refresh: Type.Optional(Type.Object({
    method: Type.String({ description: "OAuth refresh method: 'client_secret_basic' or 'client_secret_post'." }),
    tokenUrl: Type.String({ description: "OAuth token endpoint URL." }),
    clientId: Type.String({ description: "OAuth client ID." }),
    clientSecret: Type.String({ description: "OAuth client secret (write-only, never returned)." }),
  })),
});

const VaultValidateParams = Type.Object({
  vaultId: Type.String({ description: "Vault ID containing the credential (vault_…)." }),
  key: Type.String({ description: "Credential key to validate." }),
});

// ---------------------------------------------------------------------------
// Tool descriptions — extremely detailed (§11.2).
// ---------------------------------------------------------------------------

const VAULT_LIST_DESC = `List the tenant's vaults — collections of credentials (bearer tokens, environment variables, MCP OAuth tokens) registered once on the backend and referenced by ID when creating sessions, so secrets never flow through the client or local agent at session time. Use this to discover which vaults exist before attaching one to a session, to find a vault whose credentials you want to add to or validate, or to audit secret inventory. Returns each vault's ID, name, and status (active/archived). Credentials themselves are listed via the vault credentials endpoint; sensitive fields are never returned. Paginated by cursor.`;

const VAULT_CREATE_DESC = `Create a new empty vault on the backend. A vault is a named container for credentials (tokens, env vars, MCP OAuth) that you reference by ID at session creation so the sandbox receives secrets from the backend, never from the client. Use this to establish a fresh secret scope for a project, team, or environment — e.g. a 'ci-secrets' vault for automation tokens or a 'mcp-integrations' vault for third-party OAuth. After creating the vault, add credentials with remote_vault_add_credential. Vault names are unique within the tenant (1–128 chars). Returns the new vault ID.`;

const VAULT_ADD_CREDENTIAL_DESC = `Add a credential to a vault. The credential category determines the secret shape: 'static_bearer' (a bearer token for an API URL), 'environment_variable' (a secret injected as a named env var in the sandbox), or 'mcp_oauth' (an OAuth access token for an MCP server URL, with optional refresh grant for Phase 2). The secret value is WRITE-ONLY: it is accepted on input and stored encrypted server-side but never returned in any API response, so this tool echoes only the credential record (id, key, category, status) — never the secret itself. Keys are unique per vault (max 20 credentials per vault); to change a secret, archive the old credential and create a new one with the same key.`;

const VAULT_VALIDATE_DESC = `Validate the OAuth status of a credential in a vault, returning 'valid', 'invalid' (the grant is gone or returned 4xx — prompt the user to re-authenticate), or 'unknown' (transient 5xx/429/network — retry). Note: OAuth refresh and re-resolution are a Phase 2 feature; on a Phase 1 backend this returns 501 Not Implemented. Use this to detect expired or revoked MCP OAuth credentials before they cause session failures, or to check whether a token needs re-issuance. Validation is read-only and safe to call repeatedly. Returns the validation result string.`;

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/** Map the generic `secret` param to the discriminated CredentialCreate body. */
function buildCredentialBody(
  key: string,
  category: CredentialCategory,
  secret: string,
  refreshToken?: string,
  refresh?: { method: string; tokenUrl: string; clientId: string; clientSecret: string },
): CredentialCreate {
  if (category === "static_bearer") {
    return { key, category: "static_bearer", token: secret };
  }
  if (category === "environment_variable") {
    return { key, category: "environment_variable", secretValue: secret };
  }
  return {
    key,
    category: "mcp_oauth",
    accessToken: secret,
    refreshToken,
    refresh: refresh
      ? {
          method: refresh.method as "client_secret_basic" | "client_secret_post",
          tokenUrl: refresh.tokenUrl,
          clientId: refresh.clientId,
          clientSecret: refresh.clientSecret,
        }
      : undefined,
  };
}

export function createVaultTools(opts: VaultToolsOptions): ReturnType<typeof defineTool>[] {
  const { client } = opts;

  const requireClient = (): ManagedApiClient => {
    const c = client();
    if (!c) throw new Error("Pi Managed backend is not configured. Run /remote:config first.");
    return c;
  };

  const vaultList = defineTool({
    name: "remote_vault_list",
    label: "Remote vault list",
    description: VAULT_LIST_DESC,
    parameters: VaultListParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const c = requireClient();
      const res = await c.listVaults({ limit: params.limit });
      return {
        content: [{ type: "text", text: `${res.data.length} vault(s).` }],
        details: { vaults: res.data },
      };
    },
  });

  const vaultCreate = defineTool({
    name: "remote_vault_create",
    label: "Remote vault create",
    description: VAULT_CREATE_DESC,
    parameters: VaultCreateParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const c = requireClient();
      const vault = await c.createVault({ name: params.name }, `remote_vault_create_${Date.now()}`);
      return {
        content: [{ type: "text", text: `Created vault ${vault.id} (${vault.status}).` }],
        details: { vaultId: vault.id, status: vault.status },
      };
    },
  });

  const vaultAddCredential = defineTool({
    name: "remote_vault_add_credential",
    label: "Remote vault add credential",
    description: VAULT_ADD_CREDENTIAL_DESC,
    parameters: VaultAddCredentialParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const c = requireClient();
      const category = params.category as CredentialCategory;
      if (!["static_bearer", "environment_variable", "mcp_oauth"].includes(category)) {
        throw new Error(`Invalid category '${params.category}'. Must be static_bearer, environment_variable, or mcp_oauth.`);
      }
      const body = buildCredentialBody(
        params.key,
        category,
        params.secret,
        params.refreshToken,
        params.refresh,
      );
      // The secret is write-only — never include it in the tool result.
      const cred = await c.addCredential(params.vaultId, body, `remote_vault_add_cred_${Date.now()}`);
      return {
        content: [{ type: "text", text: `Added ${cred.category} credential '${cred.key}' to vault ${params.vaultId} (${cred.id}).` }],
        details: { credentialId: cred.id, vaultId: cred.vaultId, key: cred.key, category: cred.category, status: cred.status },
      };
    },
  });

  const vaultValidate = defineTool({
    name: "remote_vault_validate",
    label: "Remote vault validate",
    description: VAULT_VALIDATE_DESC,
    parameters: VaultValidateParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const c = requireClient();
      const result = await c.validateCredential(params.vaultId, params.key, `remote_vault_validate_${Date.now()}`);
      return {
        content: [{ type: "text", text: `Credential '${params.key}' validation: ${result}.` }],
        details: { key: params.key, result },
      };
    },
  });

  return [vaultList, vaultCreate, vaultAddCredential, vaultValidate];
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Register the vault `remote_*` tools. Exported for explicit wiring (§24.6). */
export function registerVaultTools(pi: ExtensionAPI, opts: VaultToolsOptions): void {
  for (const tool of createVaultTools(opts)) pi.registerTool(tool);
}
