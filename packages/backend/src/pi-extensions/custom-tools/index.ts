/**
 * Custom-tools relay extension (WP-3.4, spec §9.4 / §11.2 / §22 preamble).
 *
 * A {@link createCustomToolsRelay} factory returns a Pi `ExtensionFactory` that, for
 * each custom tool declared on the agent, registers a `defineTool` shim via
 * `pi.registerTool`. The shim's `execute`:
 *
 * 1. Relays the invocation through the {@link CustomToolRelay} (local coordinator on
 *    the primary thread; `ChildThreadCustomToolRelay` on a subagent thread). The relay
 *    emits `agent.custom_tool_use` carrying `customToolUseId` (= the event id), pauses
 *    the session (`session.status_idle` / `requires_action` + the blocking id), and
 *    awaits the matching `user.custom_tool_result`.
 * 2. On result, returns the client's output as the tool result → the session returns
 *    to `running`. The model never executes anything on its own (§11.2).
 *
 * **Permissions do NOT apply (§22 preamble).** Custom tools are executed by the
 * client, not the agent's sandbox, and the client decides whether to run them. There
 * is no `PermissionPolicy` snapshot, no `always_ask` gate, and no `user.tool_confirmation`
 * step for custom tools — every invocation is unconditionally relayed for the client
 * to fulfill. This is the deliberate contrast with `permission-gate/` (WP-2.3), which
 * gates built-in + MCP tools. See `__tests__/relay.test.ts` ("permissions do not
 * apply") and §22 preamble.
 *
 * **Wiring point:** add the returned factory to the session's `extensionFactories`
 * (passed to `DefaultResourceLoader` in `materialize.ts`). The relay instance is
 * constructed per session and shared with the inbound `user.custom_tool_result`
 * router (WP-1.7 owns that inbound handler). The factory is exercised here through a
 * fake `ExtensionAPI` (see `__tests__/`).
 */

import {
  defineTool,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { CustomToolRelay } from "./relay.js";

export type { CustomToolRelay } from "./relay.js";

/**
 * A custom tool declared on the agent (the client executes it). Mirrors the fields of
 * Pi's `ToolDefinition` that the backend materializes from the agent resource —
 * `name`, `label`, `description`, the TypeBox `parameters` schema, and optional
 * system-prompt hint fields. The shim supplies `execute`; the declaration carries none.
 */
export interface CustomToolDeclaration {
  name: string;
  label?: string;
  description: string;
  /** TypeBox parameter schema (forwarded to `ToolDefinition.parameters`). */
  parameters: unknown;
  promptSnippet?: string;
  promptGuidelines?: string[];
}

/** Options handed to {@link createCustomToolsRelay}. */
export interface CustomToolsRelayOptions {
  /** Custom tools declared on the agent (one shim registered per entry). */
  declarations: readonly CustomToolDeclaration[];
  /** The relay that owns the round-trip (local on primary, cross-post on child). */
  relay: CustomToolRelay;
}

/**
 * Build a Pi extension factory that registers a `defineTool` shim for each declared
 * custom tool. Add the returned factory to the session's `extensionFactories`.
 */
export function createCustomToolsRelay(opts: CustomToolsRelayOptions): ExtensionFactory {
  const { declarations, relay } = opts;
  return (pi: ExtensionAPI): void => {
    for (const decl of declarations) {
      pi.registerTool(buildCustomToolShim(decl, relay) as never);
    }
  };
}

/**
 * Construct one `defineTool` shim. Exported for direct unit testing (without standing
 * up a fake `ExtensionAPI`).
 */
export function buildCustomToolShim(
  decl: CustomToolDeclaration,
  relay: CustomToolRelay,
) {
  return defineTool({
    name: decl.name,
    label: decl.label ?? decl.name,
    description: decl.description,
    parameters: decl.parameters as never,
    ...(decl.promptSnippet ? { promptSnippet: decl.promptSnippet } : {}),
    ...(decl.promptGuidelines ? { promptGuidelines: decl.promptGuidelines } : {}),
    execute: async (_toolCallId: string, params: unknown) => {
      // No permission gate: unconditionally relay (§22 preamble). The client executes
      // the tool and decides whether to run it.
      const result = await relay.requestCustomToolUse({
        toolName: decl.name,
        input: ((params as Record<string, unknown> | undefined) ?? {}) as Record<
          string,
          unknown
        >,
      });
      return {
        content: [{ type: "text" as const, text: result.result }],
        details: undefined,
      };
    },
  } as never);
}
