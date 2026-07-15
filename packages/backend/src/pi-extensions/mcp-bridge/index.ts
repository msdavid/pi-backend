/**
 * MCP bridge managed Pi extension (WP-3.3, spec §19 / §25.3).
 *
 * A {@link createMcpBridge} factory returns a Pi {@link ExtensionFactory} that, on
 * extension load, connects to each configured MCP streamable-HTTP server, lists its
 * tools, and registers every one as a Pi tool via `pi.registerTool` (§19.2). Each
 * registered tool's `execute` closure routes through the {@link McpCredentialProxy}
 * — the harness (AgentSession) never sees credentials (§25.3 / §25.5).
 *
 * Flow per tool call:
 *
 *   AgentSession → execute(params) → proxy.authorize(url) → client.callTool(...)
 *                                                      ↑ token injected here,
 *                                                        fetched from the vault
 *                                                        per-session; the token
 *                                                        is a local, never
 *                                                        returned.
 *   MCP Server → result.text → maybeSpillMcpOutput (§11.3) → AgentSession
 *
 * §19.6: session creation does NOT validate MCP connectivity. If a server is
 * unreachable or rejects the credential at load time OR at call time, the bridge
 * records the failure on the {@link McpFailureTracker} and emits a `session.error`
 * via the {@link McpFailureSink} (with `mcpServerName` + `retryStatus`). Load-time
 * failures register no tools for that server (the model simply does not see them);
 * the next idle→running transition drains the tracker and re-attempts connection.
 *
 * The default permission policy for MCP tools is `always_ask` (§19.4 / §22.1) —
 * enforced by the permission-gate extension (WP-2.3), not here. This bridge only
 * registers tools and routes execution; it does not adjudicate permission.
 *
 * **Integration:** constructed per-session at materialization
 * (`domain/session-manager/materialize.ts`, read-only for this WP) with the
 * session's resolved {@link SecretBinding}s. Wiring is deferred to that path; the
 * factory + proxy are exercised here through fakes (see `__tests__/mcp-bridge.test.ts`).
 */

import { Type, type TSchema } from "typebox";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { McpServer } from "@pi-managed/contracts";
import type { SandboxHandle, SandboxProvider, SecretBinding } from "../../domain/ports.js";
import {
  McpClient,
  type McpToolDescriptor,
} from "../../domain/mcp/client.js";
import {
  McpCredentialProxy,
  type McpCredentialResolver,
} from "../../domain/mcp/proxy.js";
import {
  McpFailureTracker,
  classifyMcpFailure,
  type McpFailureSink,
} from "../../domain/mcp/failures.js";
import { maybeSpillMcpOutput } from "../../domain/mcp/output.js";

/** Prefix for registered MCP tool names (avoids collision with built-ins; the
 *  permission gate routes any non-built-in name as MCP, §22.1). */
export const MCP_TOOL_PREFIX = "mcp__";

/** Options handed to {@link createMcpBridge}. */
export interface McpBridgeOptions {
  /** The agent's MCP server roster (§19.3). */
  servers: readonly McpServer[];
  /** The session's resolved secret bindings (from `SecretStore.resolveBindingsForSession`). */
  bindings: readonly SecretBinding[];
  /** Host-side credential resolver — fetches the decrypted token for a binding. */
  resolver: McpCredentialResolver;
  /** Sink for `session.error` events (§19.6). */
  failureSink: McpFailureSink;
  /** Per-session failure tracker (records failures for idle→running retry). */
  tracker: McpFailureTracker;
  /** Optional sandbox for spilling large outputs (§11.3). When absent, a hard
   *  truncation fallback applies. */
  sandbox?: { provider: SandboxProvider; handle: SandboxHandle };
  /** Injectable client factory (tests). Defaults to {@link McpClient}. */
  clientFactory?: (url: string) => Pick<
    McpClient,
    "initialize" | "listTools" | "callTool" | "serverUrl"
  >;
  /** Connect/list timeout per server (ms). Default 10s — fail fast so a dead
   *  server does not stall session start (§19.6 no-connectivity-validation). */
  connectTimeoutMs?: number;
}

/** Build a tool name for an MCP server + tool pair. */
export function mcpToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverName}__${toolName}`;
}

/**
 * Build a Pi extension factory that registers an MCP server's tools as Pi tools,
 * backed by the credential proxy. The factory is async: Pi awaits it before
 * `session_start`, so tool discovery completes before the first turn. Per-server
 * failures are caught and reported (§19.6) — they never abort session start.
 */
export function createMcpBridge(opts: McpBridgeOptions): ExtensionFactory {
  const proxy = new McpCredentialProxy(opts.bindings, opts.resolver);
  const connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
  const clientFactory =
    opts.clientFactory ??
    ((url: string) => new McpClient(url, { timeoutMs: connectTimeoutMs }));
  return async (pi: ExtensionAPI): Promise<void> => {
    // Connect to each server in parallel; per-server failures are isolated.
    await Promise.all(
      opts.servers.map((server) =>
        connectAndRegister(pi, server, proxy, opts, clientFactory),
      ),
    );
  };
}

/**
 * Connect to one server, list its tools, and register each as a Pi tool. Any
 * failure (transport or auth) is recorded + emitted and the server's tools are
 * simply not registered — the model runs without them. The tracker ensures the
 * next idle→running transition retries.
 */
async function connectAndRegister(
  pi: ExtensionAPI,
  server: McpServer,
  proxy: McpCredentialProxy,
  opts: McpBridgeOptions,
  clientFactory: NonNullable<McpBridgeOptions["clientFactory"]>,
): Promise<void> {
  // If this server was already marked failed on a prior run and the tracker has
  // not drained it, skip reconnection here — the idle→running drain path owns
  // the retry. (On a fresh run the tracker is empty, so this is a no-op.)
  if (opts.tracker.has(server.name)) return;

  let client: ReturnType<typeof clientFactory>;
  let tools: McpToolDescriptor[];
  try {
    client = clientFactory(server.url);
    // Authorize for the initialize handshake (some servers require it up front).
    const initAuth = await proxy.authorize(server.url);
    await client.initialize(initAuth.headers);
    const listAuth = await proxy.authorize(server.url);
    tools = await client.listTools(listAuth.headers);
  } catch (err) {
    await recordFailure(opts, server.name, err);
    return;
  }

  for (const tool of tools) {
    const registered = registerOneTool(
      pi,
      server,
      tool,
      client,
      proxy,
      opts,
    );
    if (!registered) continue;
  }
}

/**
 * Register a single MCP tool as a Pi tool. Returns `true` on success. The
 * `execute` closure is the credential boundary: it calls `proxy.authorize` (token
 * fetched + injected, never returned) then `client.callTool`, then spills large
 * output. The value returned to the AgentSession carries NO credential.
 */
function registerOneTool(
  pi: ExtensionAPI,
  server: McpServer,
  tool: McpToolDescriptor,
  client: ReturnType<NonNullable<McpBridgeOptions["clientFactory"]>>,
  proxy: McpCredentialProxy,
  opts: McpBridgeOptions,
): boolean {
  const name = mcpToolName(server.name, tool.name);
  // Wrap the MCP inputSchema as a TypeBox schema (Type.Unsafe is the documented
  // escape hatch for external JSON Schemas). Validation is passthrough — the MCP
  // server validates its own inputs.
  const parameters = Type.Unsafe<Record<string, unknown>>(
    (tool.inputSchema ?? { type: "object", properties: {}, additionalProperties: true }) as TSchema,
  );

  const definition = defineTool({
    name,
    label: `${server.name} / ${tool.name}`,
    description: tool.description ?? `MCP tool ${tool.name} on server ${server.name}`,
    parameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate) {
      // §25.3: the token lives only inside `authorize` + the MCP request below.
      const auth = await proxy.authorize(server.url);
      let result;
      try {
        result = await client.callTool(
          tool.name,
          (params ?? {}) as Record<string, unknown>,
          auth.headers,
        );
      } catch (err) {
        await recordFailure(opts, server.name, err);
        const retry = classifyMcpFailure(err);
        return {
          content: [
            {
              type: "text",
              text: `MCP tool ${tool.name} failed (${retry}); the server will be retried on the next run.`,
            },
          ],
          details: { mcpServerName: server.name, retryStatus: retry, isError: true },
          isError: true,
        };
      }

      // §11.3: spill large outputs to the sandbox; the AgentSession sees only the
      // truncated preview + path, never the full payload.
      const spilled = await maybeSpillMcpOutput(result.text, opts.sandbox);
      return {
        content: [{ type: "text", text: spilled.text }],
        details: {
          mcpServerName: server.name,
          truncated: spilled.spilled,
          spillPath: spilled.path,
          approxTokens: spilled.approxTokens,
          isError: result.isError,
        },
        isError: result.isError,
      };
    },
  });

  pi.registerTool(definition);
  return true;
}

/**
 * Record a server failure: classify it, dedupe via the tracker, and emit a
 * `session.error` (§19.6). The first failure for a server emits the event;
 * repeated failures during the same run do not re-emit (the tracker dedupes).
 */
async function recordFailure(
  opts: McpBridgeOptions,
  mcpServerName: string,
  err: unknown,
): Promise<void> {
  const retryStatus = classifyMcpFailure(err);
  const isNew = opts.tracker.record(mcpServerName, retryStatus);
  if (isNew) {
    await opts.failureSink.emitMcpFailure(mcpServerName, retryStatus);
  }
}

/** Re-exported for tests / wiring. */
export { McpCredentialProxy, McpFailureTracker, maybeSpillMcpOutput };
export { McpClient, McpAuthError, McpTransportError } from "../../domain/mcp/client.js";
