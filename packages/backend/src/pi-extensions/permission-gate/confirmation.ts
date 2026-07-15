/**
 * Confirmation round-trip coordinator (WP-2.3, spec §9.5).
 *
 * Bridges the Pi `tool_call` hook (which can `await` a confirmation promise) to the
 * backend event flow:
 *
 * 1. The permission-gate extension calls {@link ConfirmationCoordinator#requestConfirmation}
 *    for an `always_ask` tool call. The returned promise **blocks the tool from
 *    executing** until the user decides.
 * 2. The coordinator emits `session.status_idle` with `stopReason: requires_action` and
 *    the **blocking event IDs** (the `toolCallId`s of every pending call) via
 *    {@link ConfirmationCoordinatorHooks#emitStatusIdleRequiresAction}.
 * 3. The client sends `user.tool_confirmation` (`allow`/`deny` + optional `denyMessage`)
 *    per blocking event. The backend routes each to
 *    {@link ConfirmationCoordinator#applyConfirmation}.
 *    - `allow` → the awaited promise resolves `{allow: true}` → the `tool_call` hook
 *      returns `undefined` → Pi executes the tool → the session returns to `running`.
 *    - `deny` → the promise resolves `{allow: false, denyMessage}` → the hook returns
 *      `{block: true, reason: denyMessage}` → Pi surfaces the rejection as the tool
 *      result (§9.5: "Denied tools return a tool result saying the call was rejected,
 *      including `denyMessage`").
 * 4. When multiple tools are pending, every blocking event ID is advertised; the client
 *    confirms each. After each decision, if any remain, `status_idle` is re-emitted with
 *    the remaining IDs.
 *
 * The coordinator is self-contained: it owns no I/O. The {@link ConfirmationCoordinatorHooks}
 * seam is the single integration point for the runtime / events-API layer (which owns
 * the outbound event queue and routes inbound `user.tool_confirmation`). That wiring
 * lands when the runtime (WP-1.5, currently read-only for this work package) gains the
 * `user.tool_confirmation` inbound handler; the coordinator is exercised here through a
 * fake emitter (see `__tests__/confirmation.test.ts`).
 */

/** A tool call awaiting user confirmation. */
export interface BlockingToolCall {
  /** The blocking event ID (the `agent.tool_use` / `agent.mcp_tool_use` event id). */
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Whether this is an MCP tool (affects policy routing, §22.1). */
  isMcp: boolean;
}

/** The user's decision for a blocking tool call. */
export interface ConfirmationDecision {
  allow: boolean;
  /** Present (and non-empty) when denied; becomes the rejection tool-result text. */
  denyMessage?: string;
}

/** Default deny message when the client omits `denyMessage` (§9.5). */
export const DEFAULT_DENY_MESSAGE = "Tool call denied by user";

/**
 * Seam the runtime / events-API layer implements to emit the `requires_action` idle
 * signal. The coordinator calls it with the **full** set of currently-pending blocking
 * event IDs whenever the set changes (a new block, or a confirmation that leaves
 * remaining blocks).
 */
export interface ConfirmationCoordinatorHooks {
  /**
   * Emit `session.status_idle` with `stopReason: "requires_action"` and the given
   * `blockingEventIds`. Called every time the pending set changes.
   */
  emitStatusIdleRequiresAction(blockingEventIds: readonly string[]): void;
}

interface PendingEntry {
  call: BlockingToolCall;
  resolve: (decision: ConfirmationDecision) => void;
}

/**
 * Coordinates the confirmation round-trip for one session. Construct per session
 * (alongside the {@link PermissionPolicySnapshot}) and share between the
 * permission-gate extension (producer of pending calls) and the inbound
 * `user.tool_confirmation` handler (consumer).
 */
export class ConfirmationCoordinator {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly hooks: ConfirmationCoordinatorHooks;

  constructor(hooks: ConfirmationCoordinatorHooks) {
    this.hooks = hooks;
  }

  /**
   * Register a tool call as awaiting confirmation and emit the `requires_action` idle
   * signal. The returned promise resolves when the user decides (via
   * {@link applyConfirmation}) or the call is aborted (via {@link abortAll}).
   */
  requestConfirmation(call: BlockingToolCall): Promise<ConfirmationDecision> {
    return new Promise<ConfirmationDecision>((resolve) => {
      this.pending.set(call.toolCallId, { call, resolve });
      this.emitIdle();
    });
  }

  /**
   * Apply a `user.tool_confirmation` decision for one blocking event.
   * @returns `true` if a pending call matched `toolCallId` and was resolved.
   */
  applyConfirmation(
    toolCallId: string,
    decision: "allow" | "deny",
    denyMessage?: string,
  ): boolean {
    const entry = this.pending.get(toolCallId);
    if (!entry) return false;
    this.pending.delete(toolCallId);
    if (decision === "deny") {
      const msg = denyMessage && denyMessage.trim().length > 0
        ? denyMessage
        : DEFAULT_DENY_MESSAGE;
      entry.resolve({ allow: false, denyMessage: msg });
    } else {
      entry.resolve({ allow: true });
    }
    // If more calls remain pending, re-advertise them so the client confirms the next.
    if (this.pending.size > 0) this.emitIdle();
    return true;
  }

  /**
   * Abort every pending call (e.g. on `user.interrupt` / session termination). Resolves
   * each as denied with the given reason so the `tool_call` hook returns a block and Pi
   * does not execute the tool.
   */
  abortAll(reason = "Session interrupted"): void {
    if (this.pending.size === 0) return;
    for (const [, entry] of this.pending) {
      entry.resolve({ allow: false, denyMessage: reason });
    }
    this.pending.clear();
  }

  /** The currently-pending blocking event IDs (in insertion order). */
  get pendingEventIds(): string[] {
    return [...this.pending.keys()];
  }

  /** Number of tool calls currently awaiting confirmation. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Is a given blocking event ID still awaiting confirmation? */
  hasPending(toolCallId: string): boolean {
    return this.pending.has(toolCallId);
  }

  private emitIdle(): void {
    const ids = [...this.pending.keys()];
    if (ids.length > 0) this.hooks.emitStatusIdleRequiresAction(ids);
  }
}
