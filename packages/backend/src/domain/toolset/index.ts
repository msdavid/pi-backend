/**
 * Built-in toolset configuration (WP-1.8, spec §11.1 / §22.2).
 *
 * Config schema, validation, defaults, permission-policy resolution, and
 * materialization for the nine built-in Pi tools. The wire shape lives in
 * `@pi-managed/contracts` (`ToolsConfig`); this module adds known-tool-name
 * validation, the §22.2 default policies, and the materialization step that
 * decides which tools the `AgentSession` actually receives.
 */

export {
  BUILT_IN_TOOL_NAMES,
  isBuiltInToolName,
  validateToolsetConfig,
  type BuiltInToolName,
  type ToolsetConfig,
  type ToolConfig,
  type PermissionPolicy,
  type ToolsConfig,
} from "./config.js";

export {
  DEFAULT_TOOLSET_CONFIG,
  DEFAULT_BUILTIN_PERMISSION_POLICY,
  DEFAULT_MCP_PERMISSION_POLICY,
  EVERYTHING_OFF_DEFAULT_CONFIG,
  enableOnly,
} from "./defaults.js";

export {
  getPermissionPolicy,
  getMcpPermissionPolicy,
} from "./permission-policy.js";

export {
  resolveTools,
  materializeToolset,
  type ResolvedTool,
  type MaterializedToolset,
} from "./materialize.js";
