/**
 * Conversation composer + turn lifecycle feature tests (WP-C4.2;
 * console-spec §10.1–10.4, journey W5). The API client is a collaborator
 * (fake at the `<ApiClientProvider>` seam); the wire behavior — the wake on
 * an idle `user.message`, the ROB-5 `409 session_not_idle` behind the
 * client-side queue — is contract-tested in
 * `src/api/__tests__/session-wake.contract.test.ts` and
 * `src/api/__tests__/session-events.contract.test.ts`.
 */
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { FakeConsoleApi } from "../../test/fake-console-api.js";
import { renderConsole } from "../../test/render-console.js";
import { axe } from "../../ui/test-utils.js";

const SESSION = "sess_01COMPOSE";
const EVENTS_PATH = `/v1/sessions/${SESSION}/events`;

beforeEach(() => {
  window.localStorage.clear();
});

function fakeWithSession(
  status: "idle" | "running" | "terminated",
  scopes = ["read", "write"],
): FakeConsoleApi {
  const api = FakeConsoleApi.signedIn(scopes);
  api.addSession({ id: SESSION, status });
  api.messages.set(SESSION, [{ role: "user", content: "earlier work" }]);
  return api;
}

/** A session idle on `requires_action` with the blocking tool_use in its log. */
function fakeRequiresAction(scopes = ["read", "write"]): FakeConsoleApi {
  const api = fakeWithSession("idle", scopes);
  api.sessions[0]!.stopReason = "requires_action";
  api.entries.set(SESSION, [
    {
      seq: 0,
      type: "agent.tool_use",
      processedAt: "2026-07-02T10:00:01.000Z",
      tool: "bash",
      input: { command: "rm -rf build/" },
      eventId: "evt_01BLOCK",
    },
    {
      seq: 1,
      type: "session.status_idle",
      processedAt: "2026-07-02T10:00:02.000Z",
      stopReason: "requires_action",
      blockingEventIds: ["evt_01BLOCK"],
    },
  ]);
  return api;
}

async function renderComposer(api: FakeConsoleApi) {
  const result = renderConsole(api, `/console/sessions/${SESSION}`);
  await screen.findByRole("tablist", { name: "Session detail" });
  await userEvent
    .setup()
    .click(screen.getByRole("tab", { name: "Conversation" }));
  const composer = await screen.findByRole("region", { name: "Composer" });
  return { ...result, composer };
}

/** The user.message POSTs the fake accepted, in order. */
function sentMessages(api: FakeConsoleApi): unknown[] {
  return api.calls
    .filter((c) => c.method === "POST" && c.path === EVENTS_PATH)
    .map((c) => c.body)
    .filter((b) => (b as { type?: string }).type === "user.message");
}

describe("send + wake (§10.1, W5 step 2)", () => {
  it("sends user.message from an idle session and shows the honest waking state", async () => {
    const user = userEvent.setup();
    const api = fakeWithSession("idle");
    const { composer } = await renderComposer(api);

    await user.type(screen.getByLabelText("Message"), "pick up where we left off");
    // The W4 steering panel above the tabs has its own Send — scope here.
    await user.click(within(composer).getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(sentMessages(api)).toEqual([
        { type: "user.message", content: "pick up where we left off" },
      ]),
    );
    // Input clears; 202 is acceptance, not a reply: the waking note holds
    // until the status transition arrives via the stream.
    expect(screen.getByLabelText("Message")).toHaveValue("");
    expect(
      await screen.findByText(/Message accepted — waking the session/),
    ).toBeInTheDocument();
  });

  it("the waking note yields once the stream flips the status to running", async () => {
    const user = userEvent.setup();
    const api = fakeWithSession("idle");
    const { composer } = await renderComposer(api);

    await user.type(screen.getByLabelText("Message"), "go");
    await user.click(within(composer).getByRole("button", { name: "Send" }));
    await screen.findByText(/waking the session/);

    api.sessions[0]!.status = "running";
    act(() => {
      api.emitStream(SESSION, {
        id: 2,
        event: "session.status_run_started",
        data: {
          type: "session.status_run_started",
          processedAt: "2026-07-02T10:00:03.000Z",
        },
      });
    });

    await waitFor(() =>
      expect(screen.queryByText(/waking the session/)).not.toBeInTheDocument(),
    );
    // The tab's turn-in-progress note takes over (§10.1 honest freshness).
    expect(
      screen.getByText(/Turn in progress — the conversation catches up/),
    ).toBeInTheDocument();
  });
});

describe("mid-turn queue (§10.2 — client-side, stated honestly)", () => {
  it("queues a mid-turn message as a chip WITHOUT posting, then sends it at idle", async () => {
    const user = userEvent.setup();
    const api = fakeWithSession("running");
    await renderComposer(api);

    await user.type(screen.getByLabelText("Message"), "also update the changelog");
    await user.click(screen.getByRole("button", { name: "Queue" }));

    // Held in this tab — the API would 409 a mid-turn user.message (ROB-5).
    const chips = screen.getByRole("list", { name: "Queued messages" });
    expect(within(chips).getByText("also update the changelog")).toBeInTheDocument();
    expect(screen.getByText(/held in this browser tab/)).toBeInTheDocument();
    expect(sentMessages(api)).toEqual([]);

    // Turn completes: the stream flips the status; the queue flushes.
    api.sessions[0]!.status = "idle";
    api.sessions[0]!.stopReason = "completed";
    act(() => {
      api.emitStream(SESSION, {
        id: 7,
        event: "session.status_idle",
        data: {
          type: "session.status_idle",
          processedAt: "2026-07-02T10:00:09.000Z",
          stopReason: "completed",
        },
      });
    });

    await waitFor(() =>
      expect(sentMessages(api)).toEqual([
        { type: "user.message", content: "also update the changelog" },
      ]),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("list", { name: "Queued messages" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("a queued chip can be removed before it is sent", async () => {
    const user = userEvent.setup();
    const api = fakeWithSession("running");
    await renderComposer(api);

    await user.type(screen.getByLabelText("Message"), "never mind");
    await user.click(screen.getByRole("button", { name: "Queue" }));
    await user.click(
      screen.getByRole("button", { name: "Remove queued message: never mind" }),
    );

    expect(
      screen.queryByRole("list", { name: "Queued messages" }),
    ).not.toBeInTheDocument();
    expect(sentMessages(api)).toEqual([]);
  });
});

describe("queue survives tab switches (F2 / C§10.2)", () => {
  it("keeps the chip when switching to Trace and back, and flushes after remount", async () => {
    const user = userEvent.setup();
    const api = fakeWithSession("running");
    await renderComposer(api);

    await user.type(screen.getByLabelText("Message"), "later work");
    await user.click(screen.getByRole("button", { name: "Queue" }));
    expect(
      within(screen.getByRole("list", { name: "Queued messages" })).getByText(
        "later work",
      ),
    ).toBeInTheDocument();

    // The waking note itself points at the Trace tab — switching there
    // unmounts the composer, so a composer-owned queue would vanish.
    await user.click(screen.getByRole("tab", { name: "Trace" }));
    expect(
      screen.queryByRole("list", { name: "Queued messages" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Conversation" }));

    // Chip survived the round trip (queue home is the session-detail page).
    const chips = await screen.findByRole("list", { name: "Queued messages" });
    expect(within(chips).getByText("later work")).toBeInTheDocument();

    // And the flush still works on the remounted composer.
    api.sessions[0]!.status = "idle";
    api.sessions[0]!.stopReason = "completed";
    act(() => {
      api.emitStream(SESSION, {
        id: 5,
        event: "session.status_idle",
        data: {
          type: "session.status_idle",
          processedAt: "2026-07-02T10:00:09.000Z",
          stopReason: "completed",
        },
      });
    });
    await waitFor(() =>
      expect(sentMessages(api)).toEqual([
        { type: "user.message", content: "later work" },
      ]),
    );
  });
});

describe("queue flush robustness (§10.2, F3/F5)", () => {
  it("a coalesced run_started+idle refetch still flushes the queue (F3 — no deadlock)", async () => {
    const user = userEvent.setup();
    const api = fakeWithSession("idle");
    const { composer } = await renderComposer(api);

    // A user.message accepted from idle: the composer is now "waking" — the
    // exact state the old awaitingTurn flag latched on, waiting to observe the
    // status LEAVE idle before it would flush again.
    await user.type(screen.getByLabelText("Message"), "first");
    await user.click(within(composer).getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(sentMessages(api)).toEqual([
        { type: "user.message", content: "first" },
      ]),
    );
    await screen.findByText(/waking the session/);

    // Queue a follow-up while waking.
    await user.type(screen.getByLabelText("Message"), "second");
    await user.click(within(composer).getByRole("button", { name: "Queue" }));

    // The turn runs AND completes so fast that its run_started + idle events
    // coalesce into a single refetch that only ever reads idle — the cache
    // never shows a non-idle status. Old code: awaitingTurn never cleared
    // (it needed to SEE the session leave idle) → the queue stranded forever.
    act(() => {
      api.emitStream(SESSION, {
        id: 9,
        event: "session.status_idle",
        data: {
          type: "session.status_idle",
          processedAt: "2026-07-02T10:00:09.000Z",
          stopReason: "completed",
        },
      });
    });

    await waitFor(() =>
      expect(sentMessages(api)).toEqual([
        { type: "user.message", content: "first" },
        { type: "user.message", content: "second" },
      ]),
    );
  });

  it("multi-chip: one message per turn boundary, in order (F5)", async () => {
    const user = userEvent.setup();
    const api = fakeWithSession("running");
    // An accepted user.message wakes the session (→ running), so a second one
    // can only be accepted after it returns to idle — the ROB-5 one-per-turn
    // guard, faithfully modelled.
    api.wakeOnMessage = true;
    await renderComposer(api);

    await user.type(screen.getByLabelText("Message"), "first");
    await user.click(screen.getByRole("button", { name: "Queue" }));
    await user.type(screen.getByLabelText("Message"), "second");
    await user.click(screen.getByRole("button", { name: "Queue" }));
    const chips = screen.getByRole("list", { name: "Queued messages" });
    expect(within(chips).getByText("first")).toBeInTheDocument();
    expect(within(chips).getByText("second")).toBeInTheDocument();

    // Turn 1 completes → idle: the FIRST queued message flushes (and wakes the
    // session), the second is held — the fake rejects a mid-turn user.message.
    api.sessions[0]!.status = "idle";
    api.sessions[0]!.stopReason = "completed";
    act(() => {
      api.emitStream(SESSION, {
        id: 10,
        event: "session.status_idle",
        data: {
          type: "session.status_idle",
          processedAt: "2026-07-02T10:00:09.000Z",
          stopReason: "completed",
        },
      });
    });
    await waitFor(() => expect(api.acceptedUserMessages).toEqual(["first"]));
    expect(
      within(screen.getByRole("list", { name: "Queued messages" })).getByText(
        "second",
      ),
    ).toBeInTheDocument();

    // Turn 2 boundary → idle again: the SECOND flushes, preserving order.
    api.sessions[0]!.status = "idle";
    api.sessions[0]!.stopReason = "completed";
    act(() => {
      api.emitStream(SESSION, {
        id: 12,
        event: "session.status_idle",
        data: {
          type: "session.status_idle",
          processedAt: "2026-07-02T10:00:11.000Z",
          stopReason: "completed",
        },
      });
    });
    await waitFor(() =>
      expect(api.acceptedUserMessages).toEqual(["first", "second"]),
    );
  });

  it("holds the queue while requires_action, resumes after the human answers (F5)", async () => {
    const user = userEvent.setup();
    const api = fakeWithSession("running");
    const { composer } = await renderComposer(api);

    await user.type(screen.getByLabelText("Message"), "after the tool");
    await user.click(screen.getByRole("button", { name: "Queue" }));

    // The turn parks on a blocking tool request: idle + requires_action.
    api.sessions[0]!.status = "idle";
    api.sessions[0]!.stopReason = "requires_action";
    api.entries.set(SESSION, [
      {
        seq: 0,
        type: "agent.tool_use",
        processedAt: "2026-07-02T10:00:01.000Z",
        tool: "bash",
        input: { command: "rm -rf build/" },
        eventId: "evt_01BLOCK",
      },
      {
        seq: 1,
        type: "session.status_idle",
        processedAt: "2026-07-02T10:00:02.000Z",
        stopReason: "requires_action",
        blockingEventIds: ["evt_01BLOCK"],
      },
    ]);
    act(() => {
      api.emitStream(SESSION, {
        id: 1,
        event: "session.status_idle",
        data: {
          type: "session.status_idle",
          processedAt: "2026-07-02T10:00:03.000Z",
          stopReason: "requires_action",
          blockingEventIds: ["evt_01BLOCK"],
        },
      });
    });

    // Held — an auto-send while a permission decision is pending would be a
    // surprise. The blocking panel is up; nothing was auto-sent; chip stays.
    const panel = await within(composer).findByRole("group", {
      name: "Blocking requests",
    });
    expect(sentMessages(api)).toEqual([]);
    expect(
      within(screen.getByRole("list", { name: "Queued messages" })).getByText(
        "after the tool",
      ),
    ).toBeInTheDocument();

    // The human approves → the turn resumes and completes.
    await user.click(within(panel).getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(
        api.calls.some(
          (c) =>
            c.path === EVENTS_PATH &&
            (c.body as { type?: string }).type === "user.tool_confirmation",
        ),
      ).toBe(true),
    );
    api.sessions[0]!.stopReason = "completed";
    act(() => {
      api.emitStream(SESSION, {
        id: 2,
        event: "session.status_idle",
        data: {
          type: "session.status_idle",
          processedAt: "2026-07-02T10:00:05.000Z",
          stopReason: "completed",
        },
      });
    });

    // Now — and only now — the queue flushes.
    await waitFor(() =>
      expect(sentMessages(api)).toEqual([
        { type: "user.message", content: "after the tool" },
      ]),
    );
  });
});

describe("interrupt (§10.2 — one click from the composer)", () => {
  it("posts user.interrupt while a turn runs", async () => {
    const user = userEvent.setup();
    const api = fakeWithSession("running");
    const { composer } = await renderComposer(api);

    await user.click(within(composer).getByRole("button", { name: "Interrupt" }));
    await waitFor(() =>
      expect(
        api.calls.some(
          (c) =>
            c.path === EVENTS_PATH &&
            (c.body as { type?: string }).type === "user.interrupt",
        ),
      ).toBe(true),
    );
  });
});

describe("requires_action in the composer (§10.2)", () => {
  it("renders approve/deny where you would type, posting the confirmation", async () => {
    const user = userEvent.setup();
    const api = fakeRequiresAction();
    const { composer } = await renderComposer(api);

    // The phase-2 panel, inline in the composer area. On the Conversation tab
    // the page-level W4 interact panel is hidden (F4), so this is the ONLY
    // Blocking-requests group — the composer owns interaction here.
    const panel = within(composer).getByRole("group", {
      name: "Blocking requests",
    });
    expect(panel).toHaveTextContent(/Waiting on you/);
    await user.click(within(panel).getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(
        api.calls.some(
          (c) =>
            c.path === EVENTS_PATH &&
            (c.body as { type?: string }).type === "user.tool_confirmation",
        ),
      ).toBe(true),
    );
  });
});

describe("scope + terminal honesty (§6.1, §5a guard rails)", () => {
  it("read scope: Send and Interrupt are disabled WITH the reason, never hidden", async () => {
    const api = fakeWithSession("running", ["read"]);
    const { composer } = await renderComposer(api);

    const send = within(composer).getByRole("button", { name: "Queue" });
    expect(send).toBeDisabled();
    expect(send).toHaveAccessibleDescription(/requires the write scope/);
    expect(
      within(composer).getByRole("button", { name: "Interrupt" }),
    ).toBeDisabled();
  });

  it("a terminated session disables sending with the fork pointer", async () => {
    const api = fakeWithSession("terminated");
    const { composer } = await renderComposer(api);

    const send = within(composer).getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    expect(send).toHaveAccessibleDescription(
      /terminated — fork it to continue/,
    );
  });
});

describe("caveats + hand-back (§10.3–10.4, W5 steps 3–4)", () => {
  it("states the resume caveats at the wake moment (idle), not mid-turn", async () => {
    await renderComposer(fakeWithSession("idle"));
    expect(
      screen.getByText(/processes from earlier turns are not preserved/),
    ).toBeInTheDocument();
  });

  it("mid-turn the caveat line is absent (no permanent noise)", async () => {
    await renderComposer(fakeWithSession("running"));
    expect(
      screen.queryByText(/processes from earlier turns are not preserved/),
    ).not.toBeInTheDocument();
  });

  it("offers the hand-back: /remote:resume with one-click copy", async () => {
    await renderComposer(fakeWithSession("idle"));
    expect(screen.getByText("Continue in Pi instead:")).toBeInTheDocument();
    expect(screen.getByText(`/remote:resume ${SESSION}`)).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: `Copy command: /remote:resume ${SESSION}`,
      }),
    ).toBeInTheDocument();
  });
});

describe("accessibility", () => {
  it("is axe-clean idle with a queued chip", async () => {
    const user = userEvent.setup();
    const api = fakeWithSession("running");
    const { view } = await renderComposer(api);
    await user.type(screen.getByLabelText("Message"), "queued one");
    await user.click(screen.getByRole("button", { name: "Queue" }));
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it("is axe-clean with requires_action in the composer", async () => {
    const { view } = await renderComposer(fakeRequiresAction());
    await screen.findAllByRole("group", { name: "Blocking requests" });
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
