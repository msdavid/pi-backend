/**
 * Built-in toolset defaults (WP-1.8, spec §11.1 / §22.2).
 *
 * Per §22.2: built-in tools default to `always_allow`; MCP tools default to
 * `always_ask` (MCP is Phase-3, but the default is exposed here for forward-compat).
 *
 * The default toolset is **everything-on**: `defaultConfig` enables all built-ins
 * with `always_allow`, and no per-tool `configs` overrides are needed (defaults apply
 * to every tool not listed in `configs`). The complementary **everything-off
 * pattern** is `defaultConfig: {enabled: false}` with per-tool enables — see
 * {@link enableOnly}.
 */

import type { PermissionPolicy, ToolConfig } from "@pi-managed/contracts";
import type { BuiltInToolName, ToolsetConfig } from "./config.js";

/** §22.2: built-in tools default to `always_allow`. */
export const DEFAULT_BUILTIN_PERMISSION_POLICY: PermissionPolicy = "always_allow";

/** §22.2: MCP tools default to `always_ask` (Phase-3 — exposed now for forward-compat). */
export const DEFAULT_MCP_PERMISSION_POLICY: PermissionPolicy = "always_ask";

/**
 * The default toolset config: all built-ins enabled with `always_allow` (§11.1, §22.2).
 * Used when an agent omits `tools` entirely.
 */
export const DEFAULT_TOOLSET_CONFIG: ToolsetConfig = {
  defaultConfig: { enabled: true, permissionPolicy: "always_allow" },
};

/**
 * The "everything-off" base config: no tool is enabled unless explicitly turned on
 * per-tool via `configs`. Combine with {@link enableOnly} for a whitelist toolset.
 */
export const EVERYTHING_OFF_DEFAULT_CONFIG: ToolConfig = { enabled: false };

/**
 * Build an **everything-off** toolset config: `defaultConfig` disables every tool,
 * then only the named tools are explicitly enabled (each with the built-in default
 * permission policy, `always_allow`). Per §22.2.
 *
 * Example:
 * ```ts
 * const cfg = enableOnly(["read", "grep"]); // only read + grep are enabled
 * ```
 */
export function enableOnly(names: readonly BuiltInToolName[]): ToolsetConfig {
  const configs: Record<string, ToolConfig> = {};
  for (const name of names) {
    configs[name] = { enabled: true, permissionPolicy: "always_allow" };
  }
  return {
    defaultConfig: { enabled: false },
    configs,
  };
}
