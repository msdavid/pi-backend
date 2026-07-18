import { describe, it, expect, vi } from "vitest";
import type { ManagedApiClient } from "../api-client.js";
import type { Session, Cursor } from "@pi-managed/contracts";
import { DelegationRecorder } from "../panel/delegation.js";
import { DELEGATION_CUSTOM_TYPE } from "../panel/types.js";
import {
  runStart,
  runResume,
  runSessions,
  runDelegate,
  runAttach,
  runFork,
} from "./remote.js";

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: "sess_new",
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

/** Console deep-link stub (console-spec §1.4) for mock clients. */
const consoleSessionUrl = (id: string) => `https://backend.test/console/sessions/${id}`;

function makeUi() {
  const notifies: { msg: string; type?: string }[] = [];
  const widgets: { key: string; lines: string[] }[] = [];
  const statuses: { key: string; text: string }[] = [];
  return {
    ui: {
      notify: (msg: string, type?: "info" | "warning" | "error") => notifies.push({ msg, type }),
      setWidget: (key: string, lines: string[] | undefined) => {
        if (lines) widgets.push({ key, lines });
      },
      setStatus: (key: string, text: string | undefined) => {
        if (text) statuses.push({ key, text });
      },
      input: vi.fn().mockResolvedValue(undefined),
      confirm: vi.fn().mockResolvedValue(true),
      select: vi.fn().mockResolvedValue(undefined),
    },
    notifies,
    widgets,
    statuses,
  };
}

function makeDeps(client: ManagedApiClient | undefined) {
  const appended: { customType: string; data: unknown }[] = [];
  const append = (ct: string, d?: unknown) => appended.push({ customType: ct, data: d });
  const recorder = new DelegationRecorder(append, () => "2026-07-13T12:00:00Z");
  const { ui, notifies, widgets, statuses } = makeUi();
  const startedPanels: { sessionId: string; mode: string }[] = [];
  return {
    deps: {
      ui,
      recorder,
      createClient: () => client,
      defaultAgent: "agent_1",
      defaultEnvironment: "env_1",
      startPanel: (sessionId: string, mode: "interactive" | "delegate") =>
        startedPanels.push({ sessionId, mode }),
    },
    appended,
    notifies,
    widgets,
    statuses,
    startedPanels,
    recorder,
  };
}

describe("/remote:* commands (§24, §24.7)", () => {
  it("/remote:delegate appends the start marker, sends the task, opens the panel", async () => {
    const createSession = vi
      .fn()
      .mockResolvedValue(makeSession({ id: "sess_del" }));
    const sendEvent = vi.fn().mockResolvedValue(undefined);
    const client = { createSession, sendEvent, consoleSessionUrl } as unknown as ManagedApiClient;
    const ctx = makeDeps(client);

    await runDelegate(ctx.deps, "fix the login bug");

    expect(createSession).toHaveBeenCalledWith({
      agent: "agent_1",
      environmentId: "env_1",
      title: "fix the login bug",
    });
    expect(sendEvent).toHaveBeenCalledWith("sess_del", {
      type: "user.message",
      content: "fix the login bug",
    });
    // Exactly ONE durable entry so far (start marker); completion is appended
    // later by the connection manager on idle/terminated.
    const ours = ctx.appended.filter((e) => e.customType === DELEGATION_CUSTOM_TYPE);
    expect(ours).toHaveLength(1);
    expect((ours[0]!.data as { kind: string }).kind).toBe("start");
    expect((ours[0]!.data as { task: string }).task).toBe("fix the login bug");
    expect(ctx.startedPanels).toEqual([{ sessionId: "sess_del", mode: "delegate" }]);
    // W3 step 1: the delegate reply prints the console deep link (console-spec §1.4).
    expect(
      ctx.notifies.some((n) => n.msg.includes("https://backend.test/console/sessions/sess_del")),
    ).toBe(true);
  });

  it("/remote:start appends a start marker and opens an interactive panel", async () => {
    const createSession = vi.fn().mockResolvedValue(makeSession({ id: "sess_start" }));
    const client = { createSession, consoleSessionUrl } as unknown as ManagedApiClient;
    const ctx = makeDeps(client);

    await runStart(ctx.deps, "agent_1 env_1");

    expect(ctx.startedPanels).toEqual([{ sessionId: "sess_start", mode: "interactive" }]);
    expect(ctx.recorder.hasStarted("sess_start")).toBe(true);
    expect(
      ctx.notifies.some((n) => n.msg.includes("https://backend.test/console/sessions/sess_start")),
    ).toBe(true);
  });

  it("/remote:resume opens an interactive panel with a console link", async () => {
    const getSession = vi.fn().mockResolvedValue(makeSession({ id: "sess_res", status: "idle" }));
    const client = { getSession, consoleSessionUrl } as unknown as ManagedApiClient;
    const ctx = makeDeps(client);

    await runResume(ctx.deps, "sess_res");
    expect(ctx.startedPanels).toEqual([{ sessionId: "sess_res", mode: "interactive" }]);
    expect(
      ctx.notifies.some((n) => n.msg.includes("https://backend.test/console/sessions/sess_res")),
    ).toBe(true);
  });

  it("/remote:resume refuses a terminated session", async () => {
    const getSession = vi
      .fn()
      .mockResolvedValue(makeSession({ id: "sess_t", status: "terminated" }));
    const client = { getSession } as unknown as ManagedApiClient;
    const ctx = makeDeps(client);

    await runResume(ctx.deps, "sess_t");
    expect(ctx.startedPanels).toHaveLength(0);
    expect(ctx.notifies.some((n) => /terminated/.test(n.msg))).toBe(true);
  });

  it("/remote:sessions lists sessions via the widget (display-only)", async () => {
    const listSessions = vi.fn().mockResolvedValue({
      data: [
        makeSession({ id: "sess_a", status: "idle", title: "task a", lastActivityAt: "t1" }),
        makeSession({ id: "sess_b", status: "running", title: "task b", lastActivityAt: "t2" }),
      ],
      nextCursor: null,
    } as Cursor<Session>);
    const client = { listSessions, consoleSessionUrl } as unknown as ManagedApiClient;
    const ctx = makeDeps(client);

    await runSessions(ctx.deps);
    // Nothing appended to the log — listing is display-only.
    expect(ctx.appended).toHaveLength(0);
    expect(ctx.widgets.some((w) => w.key === "pi-managed:sessions")).toBe(true);
    const w = ctx.widgets.find((w) => w.key === "pi-managed:sessions")!;
    expect(w.lines.join("\n")).toContain("sess_a");
    expect(w.lines.join("\n")).toContain("sess_b");
    // Each row carries its console deep link (console-spec §1.4).
    expect(w.lines.join("\n")).toContain("https://backend.test/console/sessions/sess_a");
    expect(w.lines.join("\n")).toContain("https://backend.test/console/sessions/sess_b");
  });

  it("/remote:attach records a start marker if none exists, then opens interactive", async () => {
    const getSession = vi
      .fn()
      .mockResolvedValue(makeSession({ id: "sess_att", status: "running" }));
    const client = { getSession, consoleSessionUrl } as unknown as ManagedApiClient;
    const ctx = makeDeps(client);

    await runAttach(ctx.deps, "sess_att");
    expect(ctx.recorder.hasStarted("sess_att")).toBe(true);
    expect(ctx.startedPanels).toEqual([{ sessionId: "sess_att", mode: "interactive" }]);
  });

  it("/remote:fork calls forkSession", async () => {
    const forkSession = vi
      .fn()
      .mockResolvedValue(makeSession({ id: "sess_fork", forkedFromSessionId: "sess_orig" }));
    const client = { forkSession, consoleSessionUrl } as unknown as ManagedApiClient;
    const ctx = makeDeps(client);

    await runFork(ctx.deps, "sess_orig");
    expect(forkSession).toHaveBeenCalledWith("sess_orig");
    // The new session id prints with its console deep link (console-spec §1.4).
    expect(
      ctx.notifies.some((n) => n.msg.includes("https://backend.test/console/sessions/sess_fork")),
    ).toBe(true);
  });

  it("commands surface a clear error when the backend is not configured", async () => {
    const ctx = makeDeps(undefined);
    await runStart(ctx.deps, "agent_1 env_1");
    expect(ctx.notifies.some((n) => /not configured/.test(n.msg))).toBe(true);
  });
});
