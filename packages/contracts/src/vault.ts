/**
 * @pi-managed/contracts — Vault & credential resources.
 *
 * Mirrors docs/api-reference.md §"Vaults". Collections of credentials registered once
 * and referenced by ID at session creation.
 *
 * SECURITY INVARIANT: sensitive fields (`token`, `accessToken`, `refreshToken`,
 * `clientSecret`, `secretValue`, `apiKey`) are WRITE-ONLY — present in the *create*
 * request schemas, ABSENT from the *response* schemas. Enforced by test.
 */

import { z } from "zod";
import { Name, Metadata, ResourceStatus, Timestamp } from "./common.js";
import { vaultId, vcredId } from "./ids.js";

// --- Vault ------------------------------------------------------------------

export const VaultCreate = z.object({
  name: Name,
  metadata: Metadata.optional(),
});
export type VaultCreate = z.infer<typeof VaultCreate>;

export const Vault = z.object({
  id: vaultId,
  name: Name,
  status: ResourceStatus,
  metadata: Metadata.optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Vault = z.infer<typeof Vault>;

// --- Credential categories (§12.1) -----------------------------------------
// Request schemas INCLUDE sensitive fields; response schemas do NOT.

export const StaticBearerCredentialCreate = z.object({
  key: z.string(),
  category: z.literal("static_bearer"),
  token: z.string(),
});
export type StaticBearerCredentialCreate = z.infer<typeof StaticBearerCredentialCreate>;

export const EnvironmentVariableCredentialCreate = z.object({
  key: z.string(),
  category: z.literal("environment_variable"),
  secretValue: z.string(),
});
export type EnvironmentVariableCredentialCreate = z.infer<
  typeof EnvironmentVariableCredentialCreate
>;

/** mcp_oauth — Phase 2 refresh; Phase 1 stores without refresh (§12.3).
 *
 * NOTE (WP-2.4): `refreshToken` is additive and optional. The OAuth refresh
 * grant (RFC 6749 §6) requires a refresh_token to mint a new access_token; it
 * is stored ONLY inside the encrypted `secret_enc` payload (never returned).
 */
export const McpOAuthRefresh = z.object({
  method: z.enum(["client_secret_basic", "client_secret_post"]),
  /**
   * OAuth token endpoint (RFC 6749 §6). MUST be an absolute `https` URL: the
   * unattended refresh loop POSTs the refresh_token + client credentials here
   * every ~60s once a token expires, so it must be encrypted in transit and can
   * never be an `http`/`file`/other-scheme target (SEC-3). Host/IP reachability
   * (SSRF) is enforced separately at connect time by the pinned transport
   * (`domain/net/ssrf-pin.ts`) — this schema only closes the scheme surface.
   */
  tokenUrl: z
    .string()
    .url()
    .refine(
      (u) => {
        try {
          return new URL(u).protocol === "https:";
        } catch {
          return false;
        }
      },
      { message: "tokenUrl must be an https URL" },
    ),
  clientId: z.string(),
  clientSecret: z.string(),
});
export type McpOAuthRefresh = z.infer<typeof McpOAuthRefresh>;

export const McpOauthCredentialCreate = z.object({
  key: z.string(),
  category: z.literal("mcp_oauth"),
  accessToken: z.string(),
  /** Optional refresh token (RFC 6749 §6); stored encrypted, never returned. */
  refreshToken: z.string().optional(),
  refresh: McpOAuthRefresh.optional(),
});
export type McpOauthCredentialCreate = z.infer<typeof McpOauthCredentialCreate>;

/**
 * model_provider_key — a model-provider API key (§4.2). The credential `key` is the
 * Pi provider id (e.g. "openai", "google"); `apiKey` is the write-only secret. The
 * backend resolves these host-side at session wake into the per-session in-memory
 * `AuthStorage`; they are NEVER exposed to the sandbox and NEVER returned by the API.
 */
export const ModelProviderKeyCredentialCreate = z.object({
  key: z.string(),
  category: z.literal("model_provider_key"),
  apiKey: z.string(),
});
export type ModelProviderKeyCredentialCreate = z.infer<
  typeof ModelProviderKeyCredentialCreate
>;

export const CredentialCreate = z.discriminatedUnion("category", [
  StaticBearerCredentialCreate,
  EnvironmentVariableCredentialCreate,
  McpOauthCredentialCreate,
  ModelProviderKeyCredentialCreate,
]);
export type CredentialCreate = z.infer<typeof CredentialCreate>;

// --- Credential response (NO sensitive fields) ------------------------------

export const CredentialCategory = z.enum([
  "static_bearer",
  "environment_variable",
  "mcp_oauth",
  "model_provider_key",
]);
export type CredentialCategory = z.infer<typeof CredentialCategory>;

/**
 * Credential record as returned by the API. Deliberately omits `token`,
 * `accessToken`, `refreshToken`, `clientSecret`, and `secretValue`.
 */
export const Credential = z.object({
  id: vcredId,
  vaultId: vaultId,
  key: z.string(),
  category: CredentialCategory,
  status: ResourceStatus,
  createdAt: Timestamp,
});
export type Credential = z.infer<typeof Credential>;

// --- OAuth validate (Phase 2, §12.5) ---------------------------------------

export const CredentialValidateResponse = z.enum(["valid", "invalid", "unknown"]);
export type CredentialValidateResponse = z.infer<typeof CredentialValidateResponse>;
