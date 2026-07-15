/**
 * MCP credential-injecting proxy (WP-3.3, spec §19.3 / §25.3 / §25.5).
 *
 * **The harness (AgentSession) never sees credentials (§25.3).** MCP tools are
 * registered as Pi tools (`pi.registerTool`) whose `execute` closure routes through
 * this proxy. The proxy:
 *
 * 1. Matches the tool's MCP server URL against the session's resolved
 *    {@link SecretBinding}s by **exact** URL comparison (§19.5 — scheme + trailing
 *    slash significant; see `url-match.ts`).
 * 2. Fetches the decrypted bearer token host-side via {@link McpCredentialResolver}
 *    — the same host-side resolution path the `SandboxProvider` uses for env-var
 *    creds. The token is NEVER returned to the caller's result; it exists only as
 *    a local within the request path.
 * 3. Injects the token into the outbound HTTP `Authorization` header (and returns
 *    the header set for the MCP client to send).
 *
 * The tool `execute` returns only the MCP server's tool result (text, possibly
 * spilled). No credential — header, token, or binding — appears in the value
 * returned to the AgentSession (§25.5 invariant).
 *
 * If **no** binding matches the server URL, the request proceeds unauthenticated
 * (the server may be public). But if a binding *exists* and its credential cannot
 * be resolved (absent, rotated, undecryptable, or empty), the proxy **fails closed**
 * — it throws {@link McpCredentialError} rather than egressing the request body
 * unauthenticated (SEC-7). Sending an operator-configured, credentialed request
 * without its credential would leak the (agent-influenced) request body to the
 * server while silently dropping the intended auth, so the call is refused instead.
 */

import type { SecretBinding } from "../ports.js";
import { McpAuthError } from "./client.js";
import { mcpUrlsEqual } from "./url-match.js";

/**
 * Host-side credential resolver — fetches the real secret value for a binding's
 * {@link SecretBinding.credentialRef}. Implemented by the vault/crypto layer (the
 * same component that decrypts `secret_enc` for `revalidate`); injected here as a
 * port so the proxy stays free of crypto/DB concerns and is unit-testable with a
 * fake. The returned value is the raw bearer token (already refreshed for
 * `mcp_oauth` by `SecretStore.revalidate`, §12.5).
 *
 * Returns `null` when the credential is absent/expired/undecryptable. For a binding
 * the proxy has already matched by URL, that `null` means "configured but
 * unresolvable" and the proxy **fails closed** ({@link McpCredentialProxy.authorize}
 * throws {@link McpAuthError}) rather than sending the request without its intended
 * auth (SEC-7).
 */
export interface McpCredentialResolver {
  resolveToken(ref: SecretBinding["credentialRef"]): Promise<string | null>;
}

/** Headers to send on an MCP HTTP request. */
export type McpHeaders = Record<string, string>;

/** Result of {@link McpCredentialProxy.authorize}. */
export interface AuthorizeResult {
  /** The headers to send (may include an injected `Authorization` header). */
  headers: McpHeaders;
  /** Whether a credential was injected. */
  injected: boolean;
  /** The binding used, when a token was injected (for logging/debug only — never
   *  the token itself). */
  bindingCategory?: SecretBinding["category"];
}

/**
 * Per-session credential proxy. Constructed at session materialization with the
 * session's resolved {@link SecretBinding}s (from `SecretStore.resolveBindingsForSession`).
 * Stateless aside from the binding list + resolver; safe to call concurrently.
 */
export class McpCredentialProxy {
  private readonly bindings: readonly SecretBinding[];
  private readonly resolver: McpCredentialResolver;

  constructor(
    bindings: readonly SecretBinding[],
    resolver: McpCredentialResolver,
  ) {
    // Defensive copy — bindings are opaque refs, but callers must not mutate the
    // proxy's view after construction.
    this.bindings = [...bindings];
    this.resolver = resolver;
  }

  /**
   * Resolve credentials for an MCP server URL and return the headers to send on
   * the outbound request. `baseHeaders` is merged with the injected `Authorization`
   * header; an injected header takes precedence over a caller-supplied one (the
   * proxy is the credential authority — §25.3).
   *
   * The returned {@link AuthorizeResult} carries NO token value. The token lives
   * only inside this method (as the local `token` variable).
   */
  async authorize(
    serverUrl: string,
    baseHeaders: McpHeaders = {},
  ): Promise<AuthorizeResult> {
    const binding = this.findBinding(serverUrl);
    if (!binding) {
      return { headers: { ...baseHeaders }, injected: false };
    }

    const token = await this.resolver.resolveToken(binding.credentialRef);
    if (!token) {
      // A binding EXISTS for this server but its credential could not be resolved
      // (absent, rotated, undecryptable, or empty). Fail closed (SEC-7): refuse the
      // call rather than egress the request body without the operator-configured
      // auth. Classified as an authentication failure (§19.6) by the bridge.
      throw new McpAuthError(
        `MCP credential for server ${serverUrl} is configured but could not be resolved`,
      );
    }

    return {
      headers: { ...baseHeaders, Authorization: `Bearer ${token}` },
      injected: true,
      bindingCategory: binding.category,
    };
  }

  /**
   * Find the {@link SecretBinding} whose `mcpServerUrl` exactly matches
   * `serverUrl` (§19.5). The first match wins; vault credentials are expected to
   * be unique per server URL (enforced at credential-registration time).
   */
  private findBinding(serverUrl: string): SecretBinding | undefined {
    return this.bindings.find(
      (b) =>
        (b.category === "static_bearer" || b.category === "mcp_oauth") &&
        mcpUrlsEqual(b.mcpServerUrl, serverUrl),
    );
  }
}
