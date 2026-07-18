/**
 * Trace live-tail feature tests (WP-C2.1; console-spec §8.1–§8.2, §12.2,
 * W3). The static trace behaviors are covered in `session-detail.test.tsx`;
 * this suite covers streaming: frames appending into the Query cache (no
 * parallel store), the live / polling / ended indicator, the polite ARIA
 * live region, filter interaction, terminal-status gating, and auto-scroll.
 *
 * The API client — including its stream capability — is a COLLABORATOR of
 * the components under test (CONVENTIONS.md "Fakes at the seam"):
 * `FakeConsoleApi.streamSession` stands in at the `useSessionStream` seam;
 * the real SSE transport is the subject of `src/api/stream.test.ts` and
 * `src/api/__tests__/stream.contract.test.ts`, where both sides are real.
 */
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ResponseSchema } from "../../api/client.js";
import { FAKE_TENANT, FakeConsoleApi } from "../../test/fake-console-api.js";
import { renderConsole } from "../../test/render-console.js";
import { axe } from "../../ui/test-utils.js";

const SESSION = "sess_01AAA";

beforeEach(() => {
  window.localStorage.clear();
});

/** A running session with two seeded entries (the initial slice). */
function fakeWithRunningSession(): FakeConsoleApi {
  const api = FakeConsoleApi.signedIn(["read"]);
  api.addSession({ id: SESSION, title: "live session", status: "running" });
  api.entries.set(SESSION, [
    {
      seq: 0,
      type: "user.message",
      processedAt: "2026-07-02T10:00:01.000Z",
      content: "Fix the login bug",
    },
    {
      seq: 1,
      type: "agent.tool_use",
      processedAt: "2026-07-02T10:00:02.000Z",
      tool: "bash",
      input: { command: "ls" },
    },
  ]);
  return api;
}

async function renderTrace(api: FakeConsoleApi, id = SESSION) {
  const result = renderConsole(api, `/console/sessions/${id}`);
  await screen.findByRole("list", { name: "Session events" });
  return result;
}

/** The stream is connected once the indicator reports live. */
async function untilLive(): Promise<void> {
  await screen.findByText(/live — \d+ events/);
}

/**
 * A fake whose entries GETs stall until the test calls {@link release} —
 * the "initial entries query still in flight" window of §8.1's
 * no-missed-events rule.
 */
class GatedEntriesApi extends FakeConsoleApi {
  readonly release: () => void;
  private readonly gate: Promise<void>;

  constructor() {
    super();
    let release!: () => void;
    this.gate = new Promise((resolve) => {
      release = resolve;
    });
    this.release = release;
  }

  override async get<T>(path: string, schema: ResponseSchema<T>): Promise<T> {
    if (path.includes("/entries")) await this.gate;
    return super.get(path, schema);
  }
}

describe("Trace live tail (§8.1–§8.2, W3)", () => {
  it("opens the stream for a non-terminal session and appends streamed entries", async () => {
    const api = fakeWithRunningSession();
    await renderTrace(api);
    await untilLive();
    expect(
      api.calls.some(
        (c) => c.method === "STREAM" && c.path === `/v1/sessions/${SESSION}/stream`,
      ),
    ).toBe(true);

    act(() => {
      api.emitStream(SESSION, {
        id: 2,
        event: "agent.message",
        data: {
          type: "agent.message",
          processedAt: "2026-07-02T10:00:03.000Z",
          content: "Found it — patching auth.ts",
        },
      });
    });

    expect(
      await screen.findByText("Found it — patching auth.ts"),
    ).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Session events" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    // The cache was patched, not refetched: no extra entries GET.
    expect(
      api.calls.filter((c) => c.path.includes("/entries")).length,
    ).toBe(1);
  });

  it("never duplicates an entry the slice already has (replayed frame, same seq)", async () => {
    const api = fakeWithRunningSession();
    await renderTrace(api);
    await untilLive();

    act(() => {
      api.emitStream(SESSION, {
        id: 1,
        event: "agent.tool_use",
        data: {
          type: "agent.tool_use",
          processedAt: "2026-07-02T10:00:02.000Z",
          tool: "bash",
          input: { command: "ls" },
        },
      });
    });

    const list = screen.getByRole("list", { name: "Session events" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  });

  it("frames arriving while the initial entries query is in flight are not lost (§8.1 no-missed-events)", async () => {
    const api = new GatedEntriesApi();
    api.signedIn = { scopes: ["read"], tenant: FAKE_TENANT };
    api.addSession({ id: SESSION, title: "live session", status: "running" });
    api.entries.set(SESSION, [
      {
        seq: 0,
        type: "user.message",
        processedAt: "2026-07-02T10:00:01.000Z",
        content: "Fix the login bug",
      },
      {
        seq: 1,
        type: "agent.tool_use",
        processedAt: "2026-07-02T10:00:02.000Z",
        tool: "bash",
        input: { command: "ls" },
      },
    ]);

    renderConsole(api, `/console/sessions/${SESSION}`);
    // Entries pending (gated), but the stream is already open: frames arrive
    // in the window where the entries cache has no data to patch.
    await screen.findByText("Loading events…");
    await waitFor(() =>
      expect(api.calls.some((c) => c.method === "STREAM")).toBe(true),
    );
    act(() => {
      // seq 1 is ALSO in the pending fetch response (dupe candidate) …
      api.emitStream(SESSION, {
        id: 1,
        event: "agent.tool_use",
        data: {
          type: "agent.tool_use",
          processedAt: "2026-07-02T10:00:02.000Z",
          tool: "bash",
          input: { command: "ls" },
        },
      });
      // … seq 2 is not: only the buffered frame can deliver it.
      api.emitStream(SESSION, {
        id: 2,
        event: "agent.message",
        data: {
          type: "agent.message",
          processedAt: "2026-07-02T10:00:03.000Z",
          content: "buffered while pending",
        },
      });
    });

    act(() => api.release());

    // Both frames render exactly once — nothing missed, nothing duplicated.
    expect(
      await screen.findByText("buffered while pending"),
    ).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Session events" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    // Patched, not refetched: the single initial entries GET closed the gap.
    expect(api.calls.filter((c) => c.path.includes("/entries"))).toHaveLength(1);
  });

  it("one stream per session, owned by the detail page: tab switches neither drop nor duplicate it", async () => {
    const user = userEvent.setup();
    const api = fakeWithRunningSession();
    await renderTrace(api);
    await untilLive();

    await user.click(screen.getByRole("tab", { name: "Usage" }));
    // The stream stays open off-Trace: a frame emitted now still lands in
    // the entries cache (the wire also persists it, like the real backend).
    act(() => {
      api.emitStream(SESSION, {
        id: 2,
        event: "agent.message",
        data: {
          type: "agent.message",
          processedAt: "2026-07-02T10:00:03.000Z",
          content: "landed off-tab",
        },
      });
    });
    api.entries.get(SESSION)!.push({
      seq: 2,
      type: "agent.message",
      processedAt: "2026-07-02T10:00:03.000Z",
      content: "landed off-tab",
    });

    await user.click(screen.getByRole("tab", { name: "Trace" }));
    expect(await screen.findByText("landed off-tab")).toBeInTheDocument();
    // Exactly ONE wire connection across the whole tab round-trip: the
    // detail page owns it; the Trace tab neither opened nor reopened one.
    expect(api.calls.filter((c) => c.method === "STREAM")).toHaveLength(1);
  });

  it("respects the active event-type filter as entries stream in", async () => {
    const user = userEvent.setup();
    const api = fakeWithRunningSession();
    await renderTrace(api);
    await untilLive();
    await user.selectOptions(screen.getByLabelText("Event type"), "agent.tool_use");

    act(() => {
      api.emitStream(SESSION, {
        id: 2,
        event: "agent.message",
        data: { type: "agent.message", processedAt: null, content: "hidden" },
      });
      api.emitStream(SESSION, {
        id: 3,
        event: "agent.tool_use",
        data: {
          type: "agent.tool_use",
          processedAt: null,
          tool: "grep",
          input: { pattern: "login" },
        },
      });
    });

    const list = screen.getByRole("list", { name: "Session events" });
    await waitFor(() =>
      expect(within(list).getAllByRole("listitem")).toHaveLength(2),
    );
    expect(list).not.toHaveTextContent("hidden");
    expect(list).toHaveTextContent("tool: grep");
  });

  it("announces streaming updates via a polite live region (C§12.2)", async () => {
    const api = fakeWithRunningSession();
    await renderTrace(api);
    const region = await screen.findByText(/live — 2 events/);
    // role="status" is an implicitly polite (aria-live) region.
    expect(region).toHaveAttribute("role", "status");

    act(() => {
      api.emitStream(SESSION, {
        id: 2,
        event: "agent.message",
        data: { type: "agent.message", processedAt: null, content: "more" },
      });
    });
    expect(await screen.findByText(/live — 3 events/)).toBeInTheDocument();
  });

  it("a session.status_* frame refreshes the session detail (header facts)", async () => {
    const api = fakeWithRunningSession();
    await renderTrace(api);
    await untilLive();
    expect(screen.getByText("running")).toBeInTheDocument();

    // The turn finishes: the wire session now reads idle/completed, and the
    // stream announces it — the detail cache must be invalidated, not stale.
    api.sessions[0] = {
      ...api.sessions[0]!,
      status: "idle",
      stopReason: "completed",
    };
    act(() => {
      api.emitStream(SESSION, {
        id: 2,
        event: "session.status_idle",
        data: {
          type: "session.status_idle",
          processedAt: null,
          stopReason: "completed",
        },
      });
    });

    expect(await screen.findByText("idle")).toBeInTheDocument();
    // "completed" appears in the header stop-reason chip AND in the streamed
    // entry's fact line — both are correct; assert at least the pair exists.
    expect((await screen.findAllByText("completed")).length).toBeGreaterThanOrEqual(2);
  });

  it("shows the degraded phases: polling fallback and stream ended", async () => {
    const api = fakeWithRunningSession();
    api.streamPhase = "polling";
    await renderTrace(api);
    expect(await screen.findByText(/polling — 2 events/)).toBeInTheDocument();

    act(() => api.endStream(SESSION));
    expect(await screen.findByText("stream ended")).toBeInTheDocument();
  });

  it("does not stream a terminated session (no connection, no indicator)", async () => {
    const api = FakeConsoleApi.signedIn(["read"]);
    api.addSession({ id: SESSION, title: "dead", status: "terminated" });
    api.entries.set(SESSION, [
      { seq: 0, type: "user.message", processedAt: null, content: "hi" },
    ]);
    await renderTrace(api);

    expect(api.calls.some((c) => c.method === "STREAM")).toBe(false);
    expect(screen.queryByText(/live|polling|stream ended/)).not.toBeInTheDocument();
  });

  describe("auto-scroll", () => {
    const scrollIntoView = vi.fn();

    beforeEach(() => {
      // jsdom implements no scrolling; the DOM APIs are collaborators here.
      Element.prototype.scrollIntoView = scrollIntoView;
      scrollIntoView.mockClear();
    });

    afterEach(() => {
      // @ts-expect-error restore jsdom's (absent) implementation
      delete Element.prototype.scrollIntoView;
      Object.defineProperty(document.documentElement, "scrollHeight", {
        configurable: true,
        value: 0,
      });
    });

    it("follows the tail while the user is at the bottom", async () => {
      const api = fakeWithRunningSession();
      await renderTrace(api); // viewport ≥ content: "at the bottom"
      await untilLive();

      act(() => {
        api.emitStream(SESSION, {
          id: 2,
          event: "agent.message",
          data: { type: "agent.message", processedAt: null, content: "tail" },
        });
      });
      await screen.findByText("tail");
      expect(scrollIntoView).toHaveBeenCalled();
    });

    it("leaves the viewport alone when the user scrolled up", async () => {
      // A long document with the viewport at the top: NOT at the bottom.
      Object.defineProperty(document.documentElement, "scrollHeight", {
        configurable: true,
        value: 5_000,
      });
      const api = fakeWithRunningSession();
      await renderTrace(api);
      await untilLive();
      scrollIntoView.mockClear();

      act(() => {
        api.emitStream(SESSION, {
          id: 2,
          event: "agent.message",
          data: { type: "agent.message", processedAt: null, content: "tail" },
        });
      });
      await screen.findByText("tail");
      expect(scrollIntoView).not.toHaveBeenCalled();
    });
  });

  it("is axe-clean while streaming", async () => {
    const api = fakeWithRunningSession();
    const { view } = await renderTrace(api);
    await untilLive();
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
