/**
 * Per-tool permission-policy resolution (WP-1.8, spec §22.2).
 *
 * Helper for the Phase-2 permission gate: given a {@link ToolsetConfig} and a tool
 * name, return the effective `PermissionPolicy`. Resolution order (per-tool wins):
 *
 * 1. `configs[toolName].permissionPolicy` (explicit per-tool override)
 * 2. `defaultConfig.permissionPolicy` (applies to all tools)
 * 3. {@link DEFAULT_BUILTIN_PERMISSION_POLICY} (`always_allow` for built-ins)
 *
 * MCP tools are Phase-3, but the MCP default (`always_ask`) is exposed here via
 * {@link DEFAULT_MCP_PERMISSION_POLICY} so the Phase-3 permission gate can call
 * {@link getMcpPermissionPolicy} without re-deriving the default.
 */

import type { PermissionPolicy } from "@pi-managed/contracts";
import type { ToolsetConfig } from "./config.js";
import {
  DEFAULT_BUILTIN_PERMISSION_POLICY,
  DEFAULT_MCP_PERMISSION_POLICY,
} from "./defaults.js";

/**
 * Resolve the effective permission policy for a built-in tool, merging per-tool
 * overrides with the default (per-tool wins). Built-ins default to `always_allow`.
 */
export function getPermissionPolicy(
  config: ToolsetConfig | undefined,
  toolName: string,
): PermissionPolicy {
  if (!config) return DEFAULT_BUILTIN_PERMISSION_POLICY;
  const perTool = config.configs?.[toolName];
  return (
    perTool?.permissionPolicy ??
    config.defaultConfig.permissionPolicy ??
    DEFAULT_BUILTIN_PERMISSION_POLICY
  );
}

/**
 * Resolve the effective permission policy for an MCP tool. MCP tools default to
 * `always_ask` (§22.2) and are not listed in `configs` (their names are dynamic);
 * this returns the MCP default unless a future config shape adds explicit overrides.
 *
 * Exposed for Phase-3 (MCP); the storage default is recorded now for forward-compat.
 */
export function getMcpPermissionPolicy(
  _config: ToolsetConfig | undefined,
  _toolName: string,
): PermissionPolicy {
  return DEFAULT_MCP_PERMISSION_POLICY;
}

export {
  DEFAULT_BUILTIN_PERMISSION_POLICY,
  DEFAULT_MCP_PERMISSION_POLICY,
} from "./defaults.js";
