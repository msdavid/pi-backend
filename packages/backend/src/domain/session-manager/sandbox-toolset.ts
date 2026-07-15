/**
 * Sandbox toolset assembly for `wake()` (R2.1 / R2.2, §10.2 / §11.1).
 *
 * The load-bearing constraint: the sandbox tools bind a LIVE `SandboxProvider` + handle
 * + cwd that only exist AFTER `ManagedSessionRuntime.wake()` provisions the microVM.
 * This module is what `wake()` calls once that handle exists, to turn the materialized
 * toolset into the `ToolDefinition[]` handed to Pi as `customTools`.
 *
 * Two shapes come out of `materializeToolset`:
 *  - the six file/process tools built by Pi's own `createXTool(cwd, { operations })`
 *    factories (bound to remote sandbox operations) — already valid Pi tools; passed
 *    through unchanged.
 *  - the custom `grep` tool and the backend-hosted `web_fetch` / `web_search` tools —
 *    plain `{ name, description, execute(params) }` shapes. Per the tool-factory's design
 *    (its execute functions are schema-less), the session manager wraps them here with
 *    `defineTool` + a TypeBox parameter schema so the model sees typed tools.
 *
 * Also exports the default Pi tool factories (the real `createXTool` set) and the
 * `user_bash` lockout extension (§10.2 — `!` host-shell execution is refused).
 */

import { Type, type TSchema } from "typebox";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  defineTool,
  type InlineExtension,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { disableUserBash, type RemoteToolFactories } from "./operations/tool-factory.js";
import type { BackendTool } from "./operations/web-tools.js";

/** Default guest working directory (a VM path); env-overridable. */
export function guestCwd(): string {
  return process.env.PI_SESSION_GUEST_CWD ?? "/workspace";
}

/**
 * The real Pi `createXTool` factories, adapted to the {@link RemoteToolFactories} seam
 * (`(cwd, { operations }) => tool`). Each accepts the remote sandbox operations so every
 * file/process effect lands in the microVM (§10.2).
 */
export const defaultRemoteToolFactories: RemoteToolFactories = {
  createBashTool,
  createReadTool,
  createWriteTool,
  createEditTool,
  createFindTool,
  createLsTool,
};

/**
 * The `user_bash` lockout (§10.2). Registered as an inline extension so Pi never spawns
 * a host shell for a `!` command — the handler refuses instead.
 */
export const disableUserBashExtension: InlineExtension = (pi) => {
  pi.on("user_bash", disableUserBash());
};

// --- Schema-less backend tools → typed Pi ToolDefinitions -------------------

const GrepParams = Type.Object({
  pattern: Type.String({ description: "Regex (or literal) pattern to search for." }),
  path: Type.Optional(Type.String({ description: "Directory or file to search (default: cwd)." })),
  glob: Type.Optional(Type.String({ description: "Only search files matching this glob." })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive match." })),
  literal: Type.Optional(Type.Boolean({ description: "Treat the pattern as a literal string." })),
  context: Type.Optional(Type.Number({ description: "Lines of context around each match." })),
  limit: Type.Optional(Type.Number({ description: "Max matches to return (default 100)." })),
});

const WebFetchParams = Type.Object({
  url: Type.String({ description: "The URL to fetch (SSRF-guarded)." }),
});

const WebSearchParams = Type.Object({
  query: Type.String({ description: "The search query." }),
});

/** Backend-tool names that carry no TypeBox schema and must be wrapped here. */
const BACKEND_TOOL_SCHEMAS: Record<string, TSchema> = {
  grep: GrepParams,
  web_fetch: WebFetchParams,
  web_search: WebSearchParams,
};

/** Wrap a schema-less {@link BackendTool} into a typed Pi {@link ToolDefinition}. */
function wrapBackendTool(tool: BackendTool, parameters: TSchema): ToolDefinition {
  return defineTool({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters,
    execute: async (_toolCallId, params) => {
      const result = await tool.execute(params as Record<string, unknown>);
      return {
        content: result.content,
        details: result.details,
        ...(result.terminate ? { terminate: result.terminate } : {}),
      };
    },
  });
}

/**
 * Convert the `materializeToolset` output (a name→tool map mixing Pi factory tools and
 * schema-less backend tools) into the `ToolDefinition[]` handed to Pi as `customTools`.
 * Pi factory tools pass through; `grep`/`web_fetch`/`web_search` are wrapped.
 */
export function toCustomToolDefinitions(
  tools: Record<string, unknown>,
): ToolDefinition[] {
  const out: ToolDefinition[] = [];
  for (const [name, tool] of Object.entries(tools)) {
    const schema = BACKEND_TOOL_SCHEMAS[name];
    if (schema) {
      out.push(wrapBackendTool(tool as BackendTool, schema));
    } else {
      // A Pi `createXTool` result: already a valid ToolDefinition at runtime (the
      // tool-factory returns them typed `unknown` to keep its injection seam SDK-free).
      out.push(tool as ToolDefinition);
    }
  }
  return out;
}
