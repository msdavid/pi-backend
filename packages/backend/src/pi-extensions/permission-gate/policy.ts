/**
 * Permission-policy snapshot + resolution for the managed permission gate
 * (WP-2.3, spec §22.1 / §22.2).
 *
 * At session creation the toolset config is snapshotted so a running session keeps
 * its creation-time policy even if the agent resource is later updated (§22.2).
 * {@link isAlwaysAsk} decides whether a given tool call must be confirmed before it
 * executes.
 *
 * Defaults (§22.1):
 * - Built-in tools → `always_allow` (unless overridden per-tool or via `defaultConfig`).
 * - MCP tools → `always_ask` (MCP is Phase-3, but the default is honored now).
 *
 * Policy resolution delegates to {@link getPermissionPolicy} /
 * {@link getMcpPermissionPolicy} (WP-1.8), which already implement the
 * per-tool-wins-over-default merge. This module adds the creation-time snapshot and
 * the built-in vs. MCP routing the gate needs.
 */

import type { PermissionPolicy } from "@pi-managed/contracts";
import type { ToolsetConfig } from "../../domain/toolset/config.js";
import { BUILT_IN_TOOL_NAMES } from "../../domain/toolset/config.js";
import {
  getMcpPermissionPolicy,
  getPermissionPolicy,
} from "../../domain/toolset/permission-policy.js";

/** A frozen, creation-time view of the toolset config (§22.2). */
export interface PermissionPolicySnapshot {
  /** The toolset config captured at session creation (may be `undefined`). */
  readonly toolset: ToolsetConfig | undefined;
  /** ISO timestamp the snapshot was taken (for diagnostics / §22.2 audit). */
  readonly createdAt: string;
}

/**
 * Capture a snapshot of the toolset config. Call once at session creation and reuse
 * for the life of the session so policy changes to the agent resource do not affect a
 * running session (§22.2).
 */
export function snapshotToolsetConfig(
  toolset: ToolsetConfig | undefined,
  createdAt: string = new Date().toISOString(),
): PermissionPolicySnapshot {
  // Deep-copy so later mutation of the live agent resource cannot affect a running
  // session's policy (§22.2). ToolConfig is a flat {enabled, permissionPolicy?} shape,
  // so a shallow-per-node copy is sufficient.
  const copy: ToolsetConfig | undefined = toolset
    ? {
        defaultConfig: { ...toolset.defaultConfig },
        ...(toolset.configs
          ? {
              configs: Object.fromEntries(
                Object.entries(toolset.configs).map(([k, v]) => [k, { ...v }]),
              ),
            }
          : {}),
      }
    : undefined;
  return { toolset: copy, createdAt };
}

const BUILT_IN_TOOL_NAME_SET: ReadonlySet<string> = new Set(BUILT_IN_TOOL_NAMES);

/** Is `name` one of the nine built-in Pi tools (§11.1)? */
export function isBuiltInTool(name: string): boolean {
  return BUILT_IN_TOOL_NAME_SET.has(name);
}

/**
 * Resolve the effective {@link PermissionPolicy} for a tool call.
 *
 * Built-in tools use {@link getPermissionPolicy} (per-tool override → `defaultConfig`
 * → `always_allow`). MCP tools (any name not in the built-in set, or when `isMcp` is
 * explicitly true) use {@link getMcpPermissionPolicy} → `always_ask` (§22.1).
 */
export function resolvePermissionPolicy(
  snapshot: PermissionPolicySnapshot,
  toolName: string,
  isMcp = false,
): PermissionPolicy {
  return isMcp || !isBuiltInTool(toolName)
    ? getMcpPermissionPolicy(snapshot.toolset, toolName)
    : getPermissionPolicy(snapshot.toolset, toolName);
}

/**
 * Does this tool call require user confirmation? True only when the effective policy
 * is `always_ask`. `always_allow` proceeds unconfirmed; `always_deny` is an
 * unconditional block ({@link isAlwaysDeny}), not a confirmation flow.
 */
export function isAlwaysAsk(
  snapshot: PermissionPolicySnapshot,
  toolName: string,
  isMcp = false,
): boolean {
  return resolvePermissionPolicy(snapshot, toolName, isMcp) === "always_ask";
}

/**
 * Is this tool call unconditionally blocked? True when the effective policy is
 * `always_deny` (§22.1). The gate returns a block for such calls so Pi never executes
 * the tool — no confirmation round-trip, no user override.
 */
export function isAlwaysDeny(
  snapshot: PermissionPolicySnapshot,
  toolName: string,
  isMcp = false,
): boolean {
  return resolvePermissionPolicy(snapshot, toolName, isMcp) === "always_deny";
}
