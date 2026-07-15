/**
 * Custom-tool relay coordinator (WP-3.4, spec §9.4 / §11.2 / §22 preamble).
 *
 * Bridges a Pi `defineTool` shim's `execute` (which can `await` a result promise) to
 * the backend event flow. This is the **local / primary-thread** round-trip — the
 * single-thread and primary-thread case. The cross-thread (subagent) case lives in
 * `./cross-thread.ts` and delegates to 3.1's `CrossPostCoordinator`.
 *
 * Flow (§9.4):
 *
 * 1. The relay extension's `defineTool` shim calls
 *    {@link CustomToolCoordinator#requestCustomToolUse} when the model invokes a
 *    declared custom tool. The coordinator generates a `customToolUseId` (= the
 *    `agent.custom_tool_use` event id), emits `agent.custom_tool_use` carrying it,
 *    then emits `session.status_idle` (`stopReason: requires_action` + the blocking
 *    event id). The returned promise **blocks the tool from executing** until the
 *    client responds. The model never executes anything on its own (§11.2).
 * 2. The client sends `user.custom_tool_result` keyed by `customToolUseId`. The
 *    backend routes it to {@link CustomToolCoordinator#applyCustomToolResult}, which
 *    resolves the awaited promise with the result string → the shim returns the tool
 *    result → the session returns to `running`.
 * 3. When multiple custom tools are pending, every blocking id is advertised; the
 *    client answers each. After each result, if any remain, `status_idle` is
 *    re-emitted with the remaining ids.
 *
 * **Permissions do NOT apply (§22 preamble).** Custom tools are executed by the
 * client, not by the agent's sandbox; the client decides whether to run them. There
 * is no `PermissionPolicy` snapshot consulted here and no `always_ask` gate — the
 * relay unconditionally surfaces every custom-tool invocation for the client to
 * fulfill. Contrast with `permission-gate/` (WP-2.3, §9.5), which gates built-in/MCP
 * tools behind `user.tool_confirmation`.
 *
 * **Integration note (wiring point):** this coordinator is constructed per
 * `AgentSession` alongside the relay extension (see `./index.ts`) and injected into
 * `material.extensionFactories`. The materialize factory (`domain/session-manager/
 * materialize.ts`, read-only for this WP) already forwards `material.customTools`
 * (WP-1.4 remote tool operations) to `createAgentSession`; WP-3.4's relay is wired by
 * adding the {@link createCustomToolsRelay} factory to `extensionFactories` and
 * routing inbound `user.custom_tool_result` to `applyCustomToolResult`. That runtime
 * wiring lands with the events-API inbound handler (WP-1.7 owns `domain/event-stream/`);
 * the coordinator is exercised here through a fake emitter (see `__tests__/`).
 */

import { generateEventId } from "../../domain/event-stream/wire.js";

/** A custom-tool call awaiting the client's result (§9.4). */
export interface CustomToolUse {
  /**
   * The blocking event id — equal to the `agent.custom_tool_use` event id. The
   * client echoes this back as `customToolUseId` on `user.custom_tool_result`.
   */
  customToolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
}

/** Request shape handed to the relay (the coordinator mints the `customToolUseId`). */
export interface CustomToolUseRequest {
  toolName: string;
  input: Record<string, unknown>;
}

/** The client's result for a custom-tool call (§9.4 `user.custom_tool_result`). */
export interface CustomToolResult {
  customToolUseId: string;
  /** The tool output text the client produced. */
  result: string;
  /** When true, the shim surfaces the result as a tool error (§11.2). */
  isError?: boolean;
}

/**
 * Seam the runtime / events-API layer implements to surface the round-trip. The
 * coordinator calls these with the **full** set of currently-pending blocking ids
 * whenever the pending set changes (a new use, or a result that leaves remainders).
 */
export interface CustomToolCoordinatorHooks {
  /** Emit the `agent.custom_tool_use` outbound event carrying `customToolUseId`. */
  emitCustomToolUse(use: CustomToolUse): void;
  /** Emit `session.status_idle` (`requires_action`) with the blocking event ids. */
  emitStatusIdleRequiresAction(blockingEventIds: readonly string[]): void;
}

/**
 * The port the relay extension depends on. Both the local coordinator
 * ({@link CustomToolCoordinator}) and the cross-thread relay
 * (`ChildThreadCustomToolRelay`) implement it, so the same `defineTool` shim works
 * whether the tool is invoked on the primary thread or a subagent thread.
 */
export interface CustomToolRelay {
  /** Relay a custom-tool invocation and await the client's result. */
  requestCustomToolUse(req: CustomToolUseRequest): Promise<CustomToolResult>;
}

interface PendingEntry {
  use: CustomToolUse;
  resolve: (result: CustomToolResult) => void;
}

/**
 * Coordinates the custom-tool round-trip for one session (the local / primary-thread
 * case). Construct per `AgentSession` and share between the relay extension (producer
 * of pending uses) and the inbound `user.custom_tool_result` handler (consumer).
 */
export class CustomToolCoordinator implements CustomToolRelay {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly hooks: CustomToolCoordinatorHooks;

  constructor(hooks: CustomToolCoordinatorHooks) {
    this.hooks = hooks;
  }

  /**
   * Register a custom-tool invocation, emit `agent.custom_tool_use` + the
   * `requires_action` idle signal, and await the client's result. The returned
   * promise resolves when the client responds (via {@link applyCustomToolResult}) or
   * the call is aborted (via {@link abortAll}).
   */
  requestCustomToolUse(req: CustomToolUseRequest): Promise<CustomToolResult> {
    const customToolUseId = generateEventId();
    const use: CustomToolUse = { customToolUseId, toolName: req.toolName, input: req.input };
    return new Promise<CustomToolResult>((resolve) => {
      this.pending.set(customToolUseId, { use, resolve });
      this.hooks.emitCustomToolUse(use);
      this.emitIdle();
    });
  }

  /**
   * Apply a `user.custom_tool_result` for one blocking event.
   * @returns `true` if a pending use matched `customToolUseId` and was resolved.
   */
  applyCustomToolResult(
    customToolUseId: string,
    result: string,
    isError = false,
  ): boolean {
    const entry = this.pending.get(customToolUseId);
    if (!entry) return false;
    this.pending.delete(customToolUseId);
    entry.resolve({ customToolUseId, result, isError });
    // If more uses remain pending, re-advertise them so the client answers the next.
    if (this.pending.size > 0) this.emitIdle();
    return true;
  }

  /**
   * Abort every pending use (e.g. on `user.interrupt` / session termination). Resolves
   * each with an error result so the `defineTool` shim surfaces a rejection to the
   * model instead of executing anything on its own (§11.2).
   */
  abortAll(reason = "Session interrupted"): void {
    if (this.pending.size === 0) return;
    for (const [, entry] of this.pending) {
      entry.resolve({
        customToolUseId: entry.use.customToolUseId,
        result: reason,
        isError: true,
      });
    }
    this.pending.clear();
  }

  /** The currently-pending blocking event ids (in insertion order). */
  get pendingEventIds(): string[] {
    return [...this.pending.keys()];
  }

  /** Number of custom-tool calls currently awaiting a result. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Is a given `customToolUseId` still awaiting a result? */
  hasPending(customToolUseId: string): boolean {
    return this.pending.has(customToolUseId);
  }

  private emitIdle(): void {
    const ids = [...this.pending.keys()];
    if (ids.length > 0) this.hooks.emitStatusIdleRequiresAction(ids);
  }
}
