/**
 * Toolset materialization (WP-1.8, spec §11.1 / §10.2).
 *
 * Turns a {@link ToolsetConfig} into the concrete set of tool objects handed to the
 * Pi `AgentSession`. Two steps:
 *
 * 1. {@link resolveTools} — pure config algebra: merge `defaultConfig` with per-tool
 *    `configs` (per-tool overrides default) to get, per built-in tool, its
 *    `enabled` flag + effective `PermissionPolicy`. No I/O.
 * 2. {@link materializeToolset} — construct the tool objects via
 *    {@link createRemoteTools} (session-manager WP-1.4), then **filter** the result
 *    to only enabled tools whose policy is not `always_deny`. A disabled tool — or an
 *    `always_deny` tool (§22.1) — is ABSENT from the model's tool list (§11.1):
 *    `createRemoteTools` builds all nine, and this layer drops the ones the model must
 *    never see. `always_deny` is also hard-blocked at call time by the permission gate
 *    (defense in depth).
 *
 * The per-tool `PermissionPolicy` is returned alongside the tools so the Phase-2
 * permission gate can consult it without re-parsing the config.
 */

import type { PermissionPolicy } from "@pi-managed/contracts";
import {
  BUILT_IN_TOOL_NAMES,
  type BuiltInToolName,
  type ToolsetConfig,
} from "./config.js";
import {
  DEFAULT_TOOLSET_CONFIG,
} from "./defaults.js";
import { getPermissionPolicy } from "./permission-policy.js";
import {
  createRemoteTools,
  type CreateRemoteToolsOptions,
  type RemoteToolset,
} from "../session-manager/operations/tool-factory.js";

/** The resolved state of a single built-in tool. */
export interface ResolvedTool {
  enabled: boolean;
  permissionPolicy: PermissionPolicy;
}

/**
 * Pure config algebra: resolve, for every built-in tool, its `enabled` flag and
 * effective `PermissionPolicy`. Per-tool `configs` entries override `defaultConfig`;
 * a tool absent from `configs` inherits `defaultConfig`. When `config` is `undefined`,
 * the {@link DEFAULT_TOOLSET_CONFIG} (everything-on, `always_allow`) applies.
 *
 * Enabled defaults to `true` when neither `defaultConfig.enabled` nor a per-tool
 * `enabled` is set (matches the §11.1 "all built-ins enabled" default).
 */
export function resolveTools(
  config: ToolsetConfig | undefined,
): Map<BuiltInToolName, ResolvedTool> {
  const cfg = config ?? DEFAULT_TOOLSET_CONFIG;
  const defaultEnabled = cfg.defaultConfig.enabled ?? true;
  const result = new Map<BuiltInToolName, ResolvedTool>();
  for (const name of BUILT_IN_TOOL_NAMES) {
    const perTool = cfg.configs?.[name];
    const enabled = perTool?.enabled ?? defaultEnabled;
    const permissionPolicy = getPermissionPolicy(cfg, name);
    result.set(name, { enabled, permissionPolicy });
  }
  return result;
}

/** The materialized toolset: only enabled tools, plus per-tool permission policies. */
export interface MaterializedToolset {
  /** Enabled tools only — a disabled tool is ABSENT (§11.1). */
  tools: Record<string, unknown>;
  /** Per-tool permission policy for the Phase-2 permission gate. */
  permissionPolicies: Partial<Record<BuiltInToolName, PermissionPolicy>>;
  /** Remote operations bundle (pass-through from {@link createRemoteTools}). */
  operations: RemoteToolset["operations"];
  /** Marker: `user_bash` must be disabled (pass-through from {@link createRemoteTools}). */
  userBashDisabled: true;
}

/**
 * Materialize a {@link ToolsetConfig} into concrete tool objects.
 *
 * Calls {@link createRemoteTools} (which constructs all nine built-in tools bound to
 * remote sandbox operations, §10.2), then filters the result to **only the enabled
 * tools**. A disabled tool is ABSENT from `tools` so the model never sees it (§11.1).
 * The per-tool `permissionPolicy` for each enabled tool is returned for the Phase-2
 * permission gate.
 *
 * When `config` is `undefined`, the {@link DEFAULT_TOOLSET_CONFIG} applies (all
 * built-ins enabled, `always_allow`).
 */
export function materializeToolset(
  opts: CreateRemoteToolsOptions,
  config: ToolsetConfig | undefined = DEFAULT_TOOLSET_CONFIG,
): MaterializedToolset {
  const resolved = resolveTools(config);
  // Construct the full toolset (all nine built-ins, sandbox-bound, §10.2).
  const built = createRemoteTools(opts);

  const tools: Record<string, unknown> = {};
  const permissionPolicies: Partial<Record<BuiltInToolName, PermissionPolicy>> = {};
  for (const [name, { enabled, permissionPolicy }] of resolved) {
    if (!enabled) continue;
    // `always_deny` tools are never offered to the model (defense in depth, §22.1):
    // even though the permission gate hard-blocks them at call time, excluding them
    // here means the model never sees a tool it can never use.
    if (permissionPolicy === "always_deny") continue;
    const tool = built.tools[name];
    if (tool !== undefined) {
      tools[name] = tool;
      permissionPolicies[name] = permissionPolicy;
    }
  }
  return {
    tools,
    permissionPolicies,
    operations: built.operations,
    userBashDisabled: built.userBashDisabled,
  };
}

export {
  DEFAULT_TOOLSET_CONFIG,
  DEFAULT_BUILTIN_PERMISSION_POLICY,
} from "./defaults.js";
