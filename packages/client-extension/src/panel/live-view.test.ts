import { describe, it, expect } from "vitest";
import type { ManagedApiClient, ParsedSseFrame } from "../api-client.js";
import type { Cursor, Session } from "@pi-managed/contracts";
import { ConnectionManager } from "./connection.js";
import { LiveViewPanel } from "./live-view.js";
import { DelegationRecorder } from "./delegation.js";
import { DELEGATION_CUSTOM_TYPE } from "./types.js";

/** Capturing UI: records every setStatus/setWidget/notify call. */
function makeUi() {
  const statuses: string[] = [];
  const widgets: string[][] = [];
  const notifies: { msg: string; type?: string }[] = [];
  return {
    ui: {
      setStatus: (_key: string, text: string | undefined) => {
        if (text !== undefined) statuses.push(text);
      },
      setWidget: (_key: string, content: string[] | undefined) => {
        if (content) widgets.push(content);
      },
      notify: (msg: string, type?: "info" | "warning" | "error") =>
        notifies.push({ msg, type }),
    },
    statuses,
    widgets,
    notifies,
  };
}

function frame(event: string, data: Record<string, unknown>, id?: number): ParsedSseFrame {
  return { id, event, data };
}

/** A scripted streamSession: each call shifts to the next script (list of frames). */
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

describe("LiveViewPanel + ConnectionManager (§24.7/§24.10)", () => {
  it("appends EXACTLY two entries per delegation and is display-only per event", async () => {
    const appended: { customType: string; data: unknown }[] = [];
    const append = (ct: string, d?: unknown) => appended.push({ customType: ct, data: d });
    const recorder = new DelegationRecorder(append, () => "2026-07-13T12:00:00Z");
    const { ui, widgets } = makeUi();

    // The connection appends completion on terminal frames. The START marker is
    // appended by the command (here, pre-recorded before the panel runs).
    recorder.appendStart("sess_1", "do the thing", "delegate");

    const sessionState = makeSession({ status: "running", id: "sess_1" });
    const apiClient = {
      streamSession: scriptedStream([
        // Stream 1: a drop mid-session (non-terminal frames, then generator ends).
        [
          frame("agent.message", { content: "working on it" }, 1),
          frame("agent.tool_use", { tool: "bash", input: { cmd: "ls" } }, 2),
          frame("agent.message", { content: "still going" }, 3),
        ],
        // Stream 2: terminal idle (delegation done).
        [frame("session.status_idle", { stopReason: "completed" }, 4)],
      ]),
      getSession: async (_id: string) => sessionState,
    } as unknown as ManagedApiClient;

    const panel = new LiveViewPanel({
      ui: ui,
      recorder,
      sessionId: "sess_1",
      mode: "delegate",
    });
    const cm = new ConnectionManager({
      apiClient,
      ui: ui,
      recorder,
      sessionId: "sess_1",
      mode: "delegate",
      backoffMs: 1,
      maxBackoffMs: 5,
      maxReconnects: 5,
    });

    await cm.run(panel.frameHandler);

    // Exactly two durable entries — start (pre) + completion (from idle). The
    // three streamed agent.message / tool_use frames appended NOTHING.
    const ours = appended.filter((e) => e.customType === DELEGATION_CUSTOM_TYPE);
    expect(ours).toHaveLength(2);
    expect((ours[0]!.data as { kind: string }).kind).toBe("start");
    expect((ours[1]!.data as { kind: string }).kind).toBe("completion");

    // Display-only: the streamed frames DID render to the widget (display),
    // not the log. So setWidget was called many times.
    expect(widgets.length).toBeGreaterThan(3);
  });

  it("shows 'disconnected, reconnecting…' and reconciles after an SSE drop", async () => {
    const appended: { customType: string; data: unknown }[] = [];
    const append = (ct: string, d?: unknown) => appended.push({ customType: ct, data: d });
    const recorder = new DelegationRecorder(append, () => "2026-07-13T12:00:00Z");
    const { ui, statuses } = makeUi();
    recorder.appendStart("sess_drop", "task", "delegate");

    const sessionState = makeSession({ status: "running", id: "sess_drop" });
    const apiClient = {
      streamSession: scriptedStream([
        [frame("agent.message", { content: "partial" }, 1)], // drops here
        [frame("session.status_idle", { stopReason: "completed" }, 2)],
      ]),
      getSession: async (_id: string) => sessionState, // still running → reconnect
    } as unknown as ManagedApiClient;

    const panel = new LiveViewPanel({
      ui: ui,
      recorder,
      sessionId: "sess_drop",
      mode: "delegate",
    });
    const cm = new ConnectionManager({
      apiClient,
      ui: ui,
      recorder,
      sessionId: "sess_drop",
      mode: "delegate",
      backoffMs: 1,
      maxBackoffMs: 5,
      maxReconnects: 5,
    });

    await cm.run(panel.frameHandler);

    expect(statuses).toContain("disconnected, reconnecting…");
    expect(statuses).toContain("live");
    // Reconciled to completion exactly once.
    const completions = appended.filter(
      (e) => (e.data as { kind: string }).kind === "completion",
    );
    expect(completions).toHaveLength(1);
  });

  it("interactive mode does NOT treat session.status_idle as terminal", async () => {
    const appended: { customType: string; data: unknown }[] = [];
    const append = (ct: string, d?: unknown) => appended.push({ customType: ct, data: d });
    const recorder = new DelegationRecorder(append, () => "2026-07-13T12:00:00Z");
    const { ui } = makeUi();
    recorder.appendStart("sess_int", "", "interactive");

    const sessionState = makeSession({ status: "running", id: "sess_int" });
    const apiClient = {
      streamSession: scriptedStream([
        // An idle in interactive mode is NOT terminal — the stream continues
        // (generator ends here, reconcile sees "running", reconnects), then a
        // later terminated frame ends the panel.
        [frame("session.status_idle", { stopReason: "requires_action" }, 1)],
        [frame("session.status_terminated", {}, 2)],
      ]),
      getSession: async (_id: string) => sessionState,
    } as unknown as ManagedApiClient;

    const panel = new LiveViewPanel({
      ui: ui,
      recorder,
      sessionId: "sess_int",
      mode: "interactive",
    });
    const cm = new ConnectionManager({
      apiClient,
      ui: ui,
      recorder,
      sessionId: "sess_int",
      mode: "interactive",
      backoffMs: 1,
      maxBackoffMs: 5,
      maxReconnects: 5,
    });
    await cm.run(panel.frameHandler);

    // Still exactly 2: interactive idle did NOT append a completion; only
    // the terminated frame did.
    const ours = appended.filter((e) => e.customType === DELEGATION_CUSTOM_TYPE);
    expect(ours).toHaveLength(2);
    expect((ours[1]!.data as { kind: string }).kind).toBe("completion");
    expect((ours[1]!.data as { status: string }).status).toBe("terminated");
  });

  it("surfaces offline-completed sessions as custom entries on startup", async () => {
    const appended: { customType: string; data: unknown }[] = [];
    const append = (ct: string, d?: unknown) => appended.push({ customType: ct, data: d });
    const recorder = new DelegationRecorder(append, () => "2026-07-13T12:00:00Z");

    const page: Cursor<Session> = {
      data: [
        makeSession({ id: "sess_done", status: "idle", lastActivityAt: "2026-07-13T13:00:00Z" }),
        makeSession({ id: "sess_term", status: "terminated", lastActivityAt: "2026-07-13T13:30:00Z" }),
        makeSession({ id: "sess_run", status: "running" }),
      ],
      nextCursor: null,
    };
    const apiClient = {
      listSessions: async () => page,
    } as unknown as ManagedApiClient;

    const { surfaceOfflineCompletions } = await import("./connection.js");
    const surfaced = await surfaceOfflineCompletions(apiClient, recorder);

    expect(surfaced.map((s) => s.id).sort()).toEqual(["sess_done", "sess_term"]);
    const ours = appended.filter((e) => e.customType === DELEGATION_CUSTOM_TYPE);
    expect(ours).toHaveLength(2);
    expect(ours.every((e) => (e.data as { kind: string }).kind === "offline-completion")).toBe(true);
  });
});
