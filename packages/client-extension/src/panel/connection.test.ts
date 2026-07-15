import { describe, it, expect } from "vitest";
import type { ManagedApiClient, ParsedSseFrame } from "../api-client.js";
import type { Session } from "@pi-managed/contracts";
import { ConnectionManager } from "./connection.js";
import { DelegationRecorder } from "./delegation.js";
import { DELEGATION_CUSTOM_TYPE } from "./types.js";

/** Capturing UI slice. */
function makeUi() {
  const statuses: string[] = [];
  const notifies: { msg: string; type?: string }[] = [];
  return {
    ui: {
      setStatus: (_key: string, text: string | undefined) => {
        if (text !== undefined) statuses.push(text);
      },
      setWidget: (_key: string, _content: string[] | undefined) => {},
      notify: (msg: string, type?: "info" | "warning" | "error") =>
        notifies.push({ msg, type }),
    },
    statuses,
    notifies,
  };
}

function frame(event: string, data: Record<string, unknown>, id?: number): ParsedSseFrame {
  return { id, event, data };
}

/** A scripted streamSession: each call yields the next script (list of frames). */
function scriptedStream(scripts: ParsedSseFrame[][]) {
  let call = 0;
  return async function* (_sessionId: string, _opts: unknown): AsyncGenerator<ParsedSseFrame> {
    const script = scripts[Math.min(call, scripts.length - 1)] ?? [];
    call += 1;
    for (const f of script) yield f;
  };
}

function makeSession(over: Partial<Session>): Session {
  return {
    id: "sess_1",
    agentId: "agent_1",
    agentVersion: 1,
    environmentId: "env_1",
    status: "idle",
    stopReason: null,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    vaultIds: [],
    resources: [],
    createdAt: "2026-07-13T12:00:00Z",
    updatedAt: "2026-07-13T12:00:00Z",
    lastActivityAt: "2026-07-13T12:00:00Z",
    forkedFromSessionId: null,
    ...over,
  };
}

describe("ConnectionManager — reconnect backoff reset (§24.10, R3.3)", () => {
  it("resets the reconnect budget after a successful frame so long sessions survive multiple outages", async () => {
    const appended: { customType: string; data: unknown }[] = [];
    const append = (ct: string, d?: unknown) => appended.push({ customType: ct, data: d });
    const recorder = new DelegationRecorder(append, () => "2026-07-13T12:00:00Z");
    const { ui, notifies, statuses } = makeUi();
    recorder.appendStart("sess_long", "task", "delegate");

    // Two independent drops (each stream yields a frame, then ends without a
    // terminal), then a terminal idle. With maxReconnects = 1, this ONLY
    // completes if each successful frame resets the attempts counter — without
    // the reset the SECOND drop (attempts = 2 > 1) aborts before the idle frame.
    const apiClient = {
      streamSession: scriptedStream([
        [frame("agent.message", { content: "chunk 1" }, 1)],
        [frame("agent.message", { content: "chunk 2" }, 2)],
        [frame("session.status_idle", { stopReason: "completed" }, 3)],
      ]),
      getSession: async (_id: string) => makeSession({ status: "running", id: "sess_long" }),
    } as unknown as ManagedApiClient;

    const cm = new ConnectionManager({
      apiClient,
      ui,
      recorder,
      sessionId: "sess_long",
      mode: "delegate",
      backoffMs: 1,
      maxBackoffMs: 5,
      maxReconnects: 1,
    });

    await cm.run((f) => void f);

    // No give-up notification fired, and the delegation reached completion.
    expect(notifies.filter((n) => n.type === "error")).toHaveLength(0);
    expect(statuses).toContain("disconnected, reconnecting…");
    const completions = appended.filter(
      (e) => e.customType === DELEGATION_CUSTOM_TYPE && (e.data as { kind: string }).kind === "completion",
    );
    expect(completions).toHaveLength(1);
  });

  it("still gives up when drops exceed maxReconnects WITHOUT an intervening successful frame", async () => {
    const appended: { customType: string; data: unknown }[] = [];
    const append = (ct: string, d?: unknown) => appended.push({ customType: ct, data: d });
    const recorder = new DelegationRecorder(append, () => "2026-07-13T12:00:00Z");
    const { ui, notifies } = makeUi();
    recorder.appendStart("sess_dead", "task", "delegate");

    // Every stream ends immediately with NO frames → nothing resets the counter,
    // so after maxReconnects + 1 drops the manager gives up.
    const apiClient = {
      streamSession: scriptedStream([[]]),
      getSession: async (_id: string) => makeSession({ status: "running", id: "sess_dead" }),
    } as unknown as ManagedApiClient;

    const cm = new ConnectionManager({
      apiClient,
      ui,
      recorder,
      sessionId: "sess_dead",
      mode: "delegate",
      backoffMs: 1,
      maxBackoffMs: 5,
      maxReconnects: 1,
    });

    await cm.run((f) => void f);

    expect(notifies.some((n) => n.type === "error" && /Lost connection/.test(n.msg))).toBe(true);
  });
});
