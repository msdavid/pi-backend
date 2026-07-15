/**
 * MCP referential integrity (WP-3.3, spec §19.3).
 *
 * The agent config carries two parallel MCP-related fields:
 *
 * - `mcpServers`: the connection roster (`{name, url, type:'url'}`, §19.3). Max 20.
 * - `tools.configs`: the per-tool permission config. A key that is NOT one of the
 *   nine built-in tool names (`domain/toolset/config.ts`) is interpreted as an
 *   **MCP toolset entry** scoped to the MCP server of the same name. Its
 *   `permissionPolicy` governs every tool exposed by that server (default
 *   `always_ask`, §19.4 / §22.1).
 *
 * Bidirectional referential integrity (§19.3):
 *
 * 1. Every `mcpServers` entry must be referenced by an `mcp_toolset` entry — i.e.
 *    `tools.configs[<serverName>]` must exist. A declared server with no toolset
 *    entry is "dangling" (the model would have no policy governing its tools).
 * 2. Every `mcp_toolset` entry (non-built-in `configs` key) must reference a
 *    declared `mcpServers` entry. A toolset entry naming an undeclared server is
 *    "unreferenced" (a policy with no backing connection).
 *
 * Both directions are rejected with `422 invalid_request` at agent create/update.
 * The agent service (§6.1) defers this cross-field check here — the contracts zod
 * schema is shape-only and `validateToolsetConfig` rejects ALL non-built-in keys,
 * so this module is the authority for MCP toolset entries.
 */

import { ApiError } from "../errors.js";
import {
  BUILT_IN_TOOL_NAMES,
  type ToolsetConfig,
} from "../toolset/config.js";
import type { McpServer } from "@pi-managed/contracts";

/** The set of built-in tool names — MCP toolset keys must not collide with these. */
const BUILT_IN_SET: ReadonlySet<string> = new Set(BUILT_IN_TOOL_NAMES);

/**
 * Extract the MCP toolset entry keys from a {@link ToolsetConfig}: every `configs`
 * key that is NOT a built-in tool name. These are the keys scoped to MCP servers.
 */
export function mcpToolsetKeys(config: ToolsetConfig | undefined): Set<string> {
  if (!config?.configs) return new Set();
  return new Set(
    Object.keys(config.configs).filter((k) => !BUILT_IN_SET.has(k)),
  );
}

/** The set of declared MCP server names. */
export function mcpServerNames(servers: readonly McpServer[] | undefined): Set<string> {
  return new Set((servers ?? []).map((s) => s.name));
}

/**
 * Validate §19.3 referential integrity. Throws {@link ApiError} `422 invalid_request`
 * on any dangling server or unreferenced toolset entry.
 *
 * @param servers the agent's `mcpServers` roster (may be `undefined`).
 * @param config  the agent's `tools` config (may be `undefined`).
 * @param opts.validateNameUniqueness when `true` (default), also reject duplicate
 *   server names within `mcpServers` (two servers of the same name make the
 *   toolset↔server mapping ambiguous).
 */
export function validateMcpReferentialIntegrity(
  servers: readonly McpServer[] | undefined,
  config: ToolsetConfig | undefined,
  opts: { validateNameUniqueness?: boolean } = {},
): void {
  const validateNameUniqueness = opts.validateNameUniqueness ?? true;
  const serverList = servers ?? [];

  // 0. Duplicate server names — ambiguous mapping.
  if (validateNameUniqueness) {
    const seen = new Set<string>();
    for (const s of serverList) {
      if (seen.has(s.name)) {
        throw new ApiError(
          422,
          "invalid_request",
          `duplicate mcp server name "${s.name}"; server names must be unique ` +
            `(§19.3)`,
        );
      }
      seen.add(s.name);
    }
  }

  const declared = mcpServerNames(serverList);
  const toolsetKeys = mcpToolsetKeys(config);

  // 1. Every declared server must be referenced by a toolset entry (dangling server).
  for (const s of serverList) {
    if (!toolsetKeys.has(s.name)) {
      throw new ApiError(
        422,
        "invalid_request",
        `mcp server "${s.name}" is declared in mcpServers but has no ` +
          `tools.configs entry (§19.3 referential integrity — dangling server)`,
      );
    }
  }

  // 2. Every toolset entry must reference a declared server (unreferenced toolset).
  for (const key of toolsetKeys) {
    if (!declared.has(key)) {
      throw new ApiError(
        422,
        "invalid_request",
        `tools.configs["${key}"] is an mcp toolset entry but no mcp server ` +
          `with that name is declared in mcpServers (§19.3 referential ` +
          `integrity — unreferenced toolset entry)`,
      );
    }
  }
}
