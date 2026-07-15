/**
 * MCP connector domain module (WP-3.3, spec §19).
 *
 * Barrel for the MCP connection logic owned by this package:
 * - {@link ./url-match} — §19.5 exact-match URL comparison.
 * - {@link ./proxy} — §25.3 credential-injecting proxy (harness never sees tokens).
 * - {@link ./client} — minimal streamable-HTTP MCP client.
 * - {@link ./referential} — §19.3 referential integrity (dangling → 422).
 * - {@link ./failures} — §19.6 failure classification + retry tracker.
 * - {@link ./output} — §11.3 100k-token spill rule for MCP outputs.
 *
 * The Pi extension that turns these into `pi.registerTool` registrations lives at
 * `pi-extensions/mcp-bridge`.
 */

export {
  mcpUrlsEqual,
} from "./url-match.js";
export {
  McpCredentialProxy,
  type McpCredentialResolver,
  type AuthorizeResult,
  type McpHeaders,
} from "./proxy.js";
export {
  McpClient,
  McpTransportError,
  McpAuthError,
  type McpToolDescriptor,
  type McpCallResult,
  type McpClientOptions,
} from "./client.js";
export {
  validateMcpReferentialIntegrity,
  mcpToolsetKeys,
  mcpServerNames,
} from "./referential.js";
export {
  classifyMcpFailure,
  McpFailureTracker,
  type McpRetryStatus,
  type McpFailureSink,
} from "./failures.js";
export {
  maybeSpillMcpOutput,
} from "./output.js";
