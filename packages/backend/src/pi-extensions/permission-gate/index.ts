/**
 * Permission-gate managed Pi extension (WP-2.3, spec §9.5 / §22).
 *
 * A {@link createPermissionGate} factory returns a Pi `ExtensionFactory` that hooks the
 * `tool_call` event (the reference pattern: see the Pi `examples/extensions/permission-gate.ts`
 * shipped with the SDK). For every tool call whose effective permission policy is
 * `always_ask`, the gate:
 *
 * 1. Asks the {@link ConfirmationCoordinator} for a confirmation, which blocks the tool
 *    from executing and emits `session.status_idle` (`requires_action` + blocking IDs).
 * 2. Awaits the user's `user.tool_confirmation` (`allow` / `deny` + `denyMessage`).
 * 3. `allow` → returns `undefined` → Pi runs the tool.
 *    `deny` → returns `{block: true, reason: denyMessage}` → Pi surfaces the rejection as
 *    the tool result (§9.5).
 *
 * The gate is a pure function of the creation-time {@link PermissionPolicySnapshot}
 * (§22.2) and the shared {@link ConfirmationCoordinator}; it holds no state of its own.
 *
 * **Integration note:** wiring this factory into `DefaultResourceLoader.extensionFactories`
 * happens at session materialization (WP-1.5). That path is read-only for this work
 * package; the factory + coordinator are exercised here through fakes (see
 * `__tests__/permission-gate.test.ts`).
 */

import type {
  ExtensionAPI,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  ConfirmationCoordinator,
  DEFAULT_DENY_MESSAGE,
} from "./confirmation.js";
import {
  isAlwaysAsk,
  isAlwaysDeny,
  type PermissionPolicySnapshot,
} from "./policy.js";

/** Options handed to {@link createPermissionGate}. */
export interface PermissionGateOptions {
  /** Creation-time toolset-config snapshot (§22.2). */
  snapshot: PermissionPolicySnapshot;
  /** Shared coordinator that owns the confirmation round-trip for this session. */
  coordinator: ConfirmationCoordinator;
}

/**
 * Build a Pi extension factory that gates `always_ask` tool calls behind a
 * `user.tool_confirmation` round-trip. Add the returned factory to the session's
 * `extensionFactories`.
 */
export function createPermissionGate(
  opts: PermissionGateOptions,
): (pi: ExtensionAPI) => void {
  const { snapshot, coordinator } = opts;
  return (pi: ExtensionAPI): void => {
    pi.on("tool_call", (event) => onToolCall(event, snapshot, coordinator));
  };
}

/**
 * The `tool_call` handler. Exported for direct unit testing (without standing up a
 * fake `ExtensionAPI`).
 */
export async function onToolCall(
  event: ToolCallEvent,
  snapshot: PermissionPolicySnapshot,
  coordinator: ConfirmationCoordinator,
): Promise<ToolCallEventResult | void> {
  const toolName = String(event.toolName ?? "");
  // MCP tools arrive as CustomToolCallEvent with a non-builtin `toolName`; there is no
  // explicit `mcp` flag on the event, so route by the built-in name set (§22.1).
  const isMcp = !isBuiltinName(toolName);

  // `always_deny` is an unconditional hard block (§22.1): return a block without any
  // confirmation round-trip so Pi never executes the tool, even if it was somehow
  // offered to the model. `always_deny` tools are also excluded at materialization
  // (materializeToolset) so they are never registered in the first place.
  if (isAlwaysDeny(snapshot, toolName, isMcp)) {
    return { block: true, reason: denyPolicyReason(toolName) };
  }

  if (!isAlwaysAsk(snapshot, toolName, isMcp)) return undefined;

  const toolCallId = String(event.toolCallId ?? "");
  const input = (event.input ?? {}) as Record<string, unknown>;

  const decision = await coordinator.requestConfirmation({
    toolCallId,
    toolName,
    input,
    isMcp,
  });

  // If the turn is aborted mid-confirmation, the coordinator resolves as denied via
  // `abortAll`; surface the reason and let Pi record the block.
  if (!decision.allow) {
    return {
      block: true,
      reason: decision.denyMessage ?? DEFAULT_DENY_MESSAGE,
    };
  }
  return undefined;
}

/** The rejection reason surfaced as the tool result for an `always_deny` tool (§9.5). */
function denyPolicyReason(toolName: string): string {
  return `Tool "${toolName}" is blocked by permission policy (always_deny)`;
}

/** Local copy of the built-in name check to avoid importing the whole toolset module. */
function isBuiltinName(name: string): boolean {
  return BUILTIN_TOOL_NAMES_SET.has(name);
}

const BUILTIN_TOOL_NAMES_SET: ReadonlySet<string> = new Set([
  "bash",
  "read",
  "write",
  "edit",
  "grep",
  "find",
  "ls",
  "web_fetch",
  "web_search",
]);
