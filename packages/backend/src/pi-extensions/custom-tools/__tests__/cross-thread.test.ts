/**
 * Cross-thread custom-tool relay tests (WP-3.4, §18.7).
 *
 * When a subagent (child thread) invokes a custom tool, the blocking event is
 * cross-posted to the primary thread (reusing 3.1's `CrossPostCoordinator`) tagged with
 * `sessionThreadId`, and the client's `user.custom_tool_result` (keyed by
 * `customToolUseId`) is routed back to the child. The {@link ChildThreadCustomToolRelay}
 * is exercised through a fake `ThreadCrossPostPort`.
 */

import { describe, expect, it } from "vitest";
import { ChildThreadCustomToolRelay } from "../cross-thread.js";
import type {
  BlockingResponse,
  BlockingThreadEvent,
  ThreadCrossPostPort,
} from "../../../domain/multiagent/types.js";
import { CrossPostCoordinator } from "../../../domain/multiagent/cross-posting.js";

function fakeCrossPost(
  respond: (req: BlockingThreadEvent) => BlockingResponse,
): { port: ThreadCrossPostPort; requests: BlockingThreadEvent[] } {
  const requests: BlockingThreadEvent[] = [];
  const port: ThreadCrossPostPort = {
    requestBlocking: (req: BlockingThreadEvent) => {
      requests.push(req);
      return Promise.resolve(respond(req));
    },
  };
  return { port, requests };
}

describe("ChildThreadCustomToolRelay (cross-thread)", () => {
  it("cross-posts a custom_tool_result blocking event tagged with sessionThreadId", async () => {
    const { port, requests } = fakeCrossPost((req) => ({
      kind: "custom_tool_result",
      eventId: req.eventId,
      result: "child result",
    }));
    const relay = new ChildThreadCustomToolRelay({
      sessionThreadId: "thread_child_1" as never,
      crossPost: port,
    });

    const pending = relay.requestCustomToolUse({
      toolName: "lookup_order",
      input: { orderId: "o_1" },
    });

    expect(requests).toHaveLength(1);
    const req = requests[0];
    expect(req.kind).toBe("custom_tool_result");
    expect(req.sessionThreadId).toBe("thread_child_1");
    expect(req.toolName).toBe("lookup_order");
    expect(req.input).toEqual({ orderId: "o_1" });

    const out = await pending;
    expect(out.customToolUseId).toBe(req.eventId);
    expect(out.result).toBe("child result");
    expect(out.isError).toBe(false);
  });

  it("routes the user.custom_tool_result back to the originating child via the real CrossPostCoordinator", async () => {
    // Use the real CrossPostCoordinator (3.1) to prove end-to-end routing: the child
    // blocks → primary advertises the blocking id → client result keyed by that id
    // resolves the child's await.
    const emitted: { ids: string[] }[] = [];
    const crossPost = new CrossPostCoordinator({
      emitPrimaryBlocking: (events) =>
        emitted.push({ ids: events.map((e) => e.eventId) }),
    });

    const relay = new ChildThreadCustomToolRelay({
      sessionThreadId: "thread_child_7" as never,
      crossPost: crossPost,
    });

    const pending = relay.requestCustomToolUse({
      toolName: "fetch_doc",
      input: { uri: "x" },
    });

    // The primary thread advertised the blocking id (cross-posted).
    expect(emitted).toEqual([{ ids: [expect.any(String)] }]);
    const blockingId = emitted[0].ids[0];
    expect(crossPost.pendingCount).toBe(1);
    expect(crossPost.hasPending(blockingId)).toBe(true);

    // Client sends user.custom_tool_result keyed by customToolUseId (the blocking id).
    const routed = crossPost.applyCustomToolResult(blockingId, "doc body");
    expect(routed).toBe(true);
    expect(crossPost.pendingCount).toBe(0);

    const out = await pending;
    expect(out.result).toBe("doc body");
    expect(out.customToolUseId).toBe(blockingId);
  });

  it("a mismatched customToolUseId is not routed (child still waiting)", async () => {
    const crossPost = new CrossPostCoordinator({
      emitPrimaryBlocking: () => {},
    });
    const relay = new ChildThreadCustomToolRelay({
      sessionThreadId: "thread_child_2" as never,
      crossPost: crossPost,
    });

    const pending = relay.requestCustomToolUse({ toolName: "t", input: {} });
    const blockingId = [...crossPost.pendingEvents][0].eventId;

    // Wrong key → not routed.
    expect(crossPost.applyCustomToolResult("evt_wrong", "nope")).toBe(false);
    expect(crossPost.pendingCount).toBe(1);

    // Correct key resolves.
    crossPost.applyCustomToolResult(blockingId, "ok");
    await expect(pending).resolves.toMatchObject({ result: "ok" });
  });
});
