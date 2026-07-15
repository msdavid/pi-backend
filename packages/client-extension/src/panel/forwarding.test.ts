import { describe, it, expect, vi } from "vitest";
import type { ManagedApiClient } from "../api-client.js";
import { forwardPrompt, shouldForwardPrompt } from "./forwarding.js";

/** Build a fake client capturing sendEvent calls. */
function makeClient() {
  const sent: { sessionId: string; event: unknown }[] = [];
  const apiClient = {
    sendEvent(sessionId: string, event: unknown): Promise<void> {
      sent.push({ sessionId, event });
      return Promise.resolve();
    },
  };
  return { apiClient: apiClient as unknown as ManagedApiClient, sent };
}

describe("forwarding rules (§24.7 #4)", () => {
  it("interactive mode forwards local prompts as user.message", async () => {
    const { apiClient, sent } = makeClient();
    const forwarded = await forwardPrompt(apiClient, "sess_1", "interactive", "Fix the bug");

    expect(forwarded).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      sessionId: "sess_1",
      event: { type: "user.message", content: "Fix the bug" },
    });
  });

  it("delegate mode does NOT forward local prompts", async () => {
    const { apiClient, sent } = makeClient();
    const forwarded = await forwardPrompt(apiClient, "sess_1", "delegate", "Fix the bug");

    expect(forwarded).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("shouldForwardPrompt reflects the mode gate", () => {
    expect(shouldForwardPrompt("interactive")).toBe(true);
    expect(shouldForwardPrompt("delegate")).toBe(false);
  });

  it("empty prompts are not forwarded even in interactive mode", async () => {
    const { apiClient, sent } = makeClient();
    const forwarded = await forwardPrompt(apiClient, "sess_1", "interactive", "   ");
    expect(forwarded).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("forwards to the correct session id (not the local agent's)", async () => {
    const { apiClient, sent } = makeClient();
    await forwardPrompt(apiClient, "sess_target", "interactive", "hello");
    expect(sent[0]!.sessionId).toBe("sess_target");
  });

  it("a mocked sendEvent is awaited (verifies the call shape)", async () => {
    const sendEvent = vi.fn().mockResolvedValue(undefined);
    const apiClient = { sendEvent } as unknown as ManagedApiClient;
    await forwardPrompt(apiClient, "sess_x", "interactive", "go");
    expect(sendEvent).toHaveBeenCalledWith("sess_x", { type: "user.message", content: "go" });
  });
});
