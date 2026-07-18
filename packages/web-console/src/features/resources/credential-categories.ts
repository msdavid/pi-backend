/**
 * Per-category presentation + request-shaping for vault credentials
 * (WP-C3.3; console-spec §9.3, api-reference §"Vaults", contracts
 * `CredentialCreate`). One secret field per category — the same minimal
 * surface as `/remote:vault add-cred` (client-extension `commands/vault.ts`);
 * the optional `mcp_oauth` refresh config is an API-only extra.
 */
import type {
  CredentialCategory,
  CredentialCreate,
  CredentialValidateResponse,
} from "@pi-managed/contracts";

export interface CategoryMeta {
  /** Section heading. */
  title: string;
  /** One line of DP-6 microcopy for the section. */
  description: string;
  keyLabel: string;
  keyHint: string;
  secretLabel: string;
}

/**
 * Render order leads with `model_provider_key` — the fail-closed category
 * (§9.3/DP-6): without a resolvable one, sessions fail before the first
 * model call.
 */
export const CATEGORY_ORDER: readonly CredentialCategory[] = [
  "model_provider_key",
  "static_bearer",
  "environment_variable",
  "mcp_oauth",
];

export const CATEGORY_META: Record<CredentialCategory, CategoryMeta> = {
  model_provider_key: {
    title: "Model provider keys",
    description:
      "Your model-provider API key, resolved host-side at session wake and never exposed to the sandbox. Fail-closed: no resolvable key means sessions fail before the first model call.",
    keyLabel: "Provider id",
    keyHint: 'The Pi provider id, e.g. "anthropic" or "openai".',
    secretLabel: "API key",
  },
  static_bearer: {
    title: "Static bearer tokens",
    description:
      "A token sent as an Authorization: Bearer header to the server named by the key.",
    keyLabel: "Server URL",
    keyHint: "The MCP server URL this token authenticates against.",
    secretLabel: "Bearer token",
  },
  environment_variable: {
    title: "Environment variables",
    description:
      "A secret injected into the sandbox as the environment variable named by the key.",
    keyLabel: "Variable name",
    keyHint: 'The environment variable to set, e.g. "GIT_TOKEN".',
    secretLabel: "Secret value",
  },
  mcp_oauth: {
    title: "MCP OAuth tokens",
    description:
      "An OAuth access token for the MCP server named by the key; Validate probes the live grant.",
    keyLabel: "MCP server URL",
    keyHint: "The MCP server the OAuth grant belongs to.",
    secretLabel: "Access token",
  },
};

/** Shape the discriminated create body; the secret is write-only (§12.4). */
export function buildCredentialBody(
  category: CredentialCategory,
  key: string,
  secret: string,
): CredentialCreate {
  switch (category) {
    case "static_bearer":
      return { key, category, token: secret };
    case "environment_variable":
      return { key, category, secretValue: secret };
    case "mcp_oauth":
      return { key, category, accessToken: secret };
    case "model_provider_key":
      return { key, category, apiKey: secret };
  }
}

/** One line per §12.5 validate outcome (DP-6). */
export const VALIDATION_COPY: Record<CredentialValidateResponse, string> = {
  valid: "valid — the grant is live",
  invalid: "invalid — the grant is gone; add a fresh credential",
  unknown: "unknown — transient or nothing to probe; retry later",
};
