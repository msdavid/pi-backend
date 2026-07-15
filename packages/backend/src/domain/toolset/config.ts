/**
 * Built-in toolset config schema & validation (WP-1.8, spec §11.1 / §22.2).
 *
 * The wire shape (`defaultConfig` + per-tool `configs`) is defined in
 * `@pi-managed/contracts` (`ToolsConfig` / `ToolConfig` / `PermissionPolicy`).
 * This module adds the **cross-field referential-integrity** check the contracts
 * schema defers: every `configs` key must name one of the nine built-in Pi tools
 * the backend can construct (the agent service validates shape only — see
 * `domain/agent/agent.ts`).
 *
 * Known built-in tool names (§11.1): the seven file/process tools (`bash`, `read`,
 * `write`, `edit`, `grep`, `find`, `ls`) plus the two backend-hosted web tools
 * (`web_fetch`, `web_search`). MCP tools are Phase-3; their names are dynamic, so
 * they are NOT validated here.
 */

import { ApiError } from "../errors.js";
import type {
  PermissionPolicy,
  ToolConfig,
  ToolsConfig,
} from "@pi-managed/contracts";

// Re-export the contracts wire types so callers have a single import surface.
export type { PermissionPolicy, ToolConfig };

/**
 * The nine built-in Pi tools the backend can construct (§11.1). Order is stable for
 * deterministic iteration / error messages.
 */
export const BUILT_IN_TOOL_NAMES = [
  "bash",
  "read",
  "write",
  "edit",
  "grep",
  "find",
  "ls",
  "web_fetch",
  "web_search",
] as const;

/** A known built-in tool name (string-literal union). */
export type BuiltInToolName = (typeof BUILT_IN_TOOL_NAMES)[number];

const BUILT_IN_TOOL_NAME_SET: ReadonlySet<string> = new Set(BUILT_IN_TOOL_NAMES);

/**
 * Toolset config as consumed by this domain module. Structurally identical to the
 * contracts {@link ToolsConfig} wire shape, except `configs` is optional (callers may
 * omit it to rely on `defaultConfig` alone). A contracts `ToolsConfig` value (with
 * `configs` required) is assignable to this type, so the two interoperate freely.
 */
export interface ToolsetConfig {
  defaultConfig: ToolConfig;
  configs?: Record<string, ToolConfig>;
}

/** Convenient alias matching the contracts wire type. */
export type { ToolsConfig };

/**
 * Validate a {@link ToolsetConfig}: every `configs` key must be a known built-in
 * tool name. Throws {@link ApiError} `422 invalid_request` on an unknown name.
 *
 * Shape itself is already zod-validated at the contracts boundary (in
 * `domain/agent/agent.ts`); this is the referential-integrity check the contracts
 * schema defers (it uses `z.record(z.string(), ToolConfig)`, which accepts any key).
 */
export function validateToolsetConfig(config: ToolsetConfig): void {
  const names = Object.keys(config.configs ?? {});
  for (const name of names) {
    if (!BUILT_IN_TOOL_NAME_SET.has(name)) {
      throw new ApiError(
        422,
        "invalid_request",
        `unknown tool name "${name}" in tools.configs; known built-in tools: ` +
          BUILT_IN_TOOL_NAMES.join(", "),
      );
    }
  }
}

/** Is `name` one of the known built-in tools? */
export function isBuiltInToolName(name: string): name is BuiltInToolName {
  return BUILT_IN_TOOL_NAME_SET.has(name);
}
