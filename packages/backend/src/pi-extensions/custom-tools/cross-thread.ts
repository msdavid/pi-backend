/**
 * Cross-thread custom-tool relay (WP-3.4, spec §18.7).
 *
 * When a **subagent** (child thread) invokes a custom tool, it cannot surface the
 * `agent.custom_tool_use` → `user.custom_tool_result` round-trip on its own stream:
 * the user only watches the *primary* thread. So the blocking event is cross-posted
 * to the primary thread via 3.1's {@link CrossPostCoordinator} (reused, not
 * reimplemented), tagged with the originating `sessionThreadId`. The client's
 * `user.custom_tool_result` (keyed by `customToolUseId` = the cross-posted event id)
 * is routed back to the correct child by the multiagent router, which calls
 * `CrossPostCoordinator.applyCustomToolResult`.
 *
 * This adapter implements the same {@link CustomToolRelay} port as the local
 * {@link CustomToolCoordinator}, so the relay extension's `defineTool` shims are
 * identical on primary and child threads — only the relay instance differs.
 *
 * Per §18.2, child threads do not load the subagent extension, so delegation is one
 * level deep; a custom-tool block on a child therefore always cross-posts to the
 * primary, never to another child.
 */

import type { ThreadId } from "../../domain/event-stream/thread-events.js";
import type {
  BlockingResponse,
  BlockingThreadEvent,
  ThreadCrossPostPort,
} from "../../domain/multiagent/types.js";
import { generateEventId } from "../../domain/event-stream/wire.js";
import type {
  CustomToolRelay,
  CustomToolResult,
  CustomToolUseRequest,
} from "./relay.js";

/** Options for constructing a {@link ChildThreadCustomToolRelay}. */
export interface ChildThreadCustomToolRelayOptions {
  /** The originating child thread id (surfaced on the primary's blocking summary). */
  sessionThreadId: ThreadId;
  /** 3.1's cross-post coordinator port (owns the primary-thread round-trip). */
  crossPost: ThreadCrossPostPort;
}

/**
 * A {@link CustomToolRelay} that cross-posts each custom-tool invocation to the
 * primary thread and awaits the routed `user.custom_tool_result`. Used on child
 * threads in place of the local {@link CustomToolCoordinator}.
 */
export class ChildThreadCustomToolRelay implements CustomToolRelay {
  private readonly sessionThreadId: ThreadId;
  private readonly crossPost: ThreadCrossPostPort;

  constructor(opts: ChildThreadCustomToolRelayOptions) {
    this.sessionThreadId = opts.sessionThreadId;
    this.crossPost = opts.crossPost;
  }

  async requestCustomToolUse(req: CustomToolUseRequest): Promise<CustomToolResult> {
    const customToolUseId = generateEventId();
    const blocking: BlockingThreadEvent = {
      sessionThreadId: this.sessionThreadId,
      eventId: customToolUseId,
      toolName: req.toolName,
      input: req.input,
      kind: "custom_tool_result",
    };
    const response: BlockingResponse =
      await this.crossPost.requestBlocking(blocking);
    return {
      customToolUseId: response.eventId,
      result: response.result ?? "",
      isError: false,
    };
  }
}
