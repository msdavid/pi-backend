/**
 * Session detail feature tests (WP-C1.7; console-spec §7.3–§7.4, §9.9
 * minimal, W2 steps 2–4). Covers the v1-parity items 8–19 of the checklist in
 * `./sessions.test.tsx`, plus the new-in-C1.7 behaviors: DP-1 header facts,
 * Trace/Usage tabs, event-type filter, collapsed payloads (DP-2), favorites
 * and recents (§7.2), and the WP-C2.3 additions: the §7.3 tab set and the
 * Fork action (W6; Tree/Outputs tab behavior lives in `./tree-tab.test.tsx`
 * / `./outputs-tab.test.tsx`). The API client is a collaborator (fake at the
 * `<ApiClientProvider>` seam).
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { ConsoleApiError } from "../../api/client.js";
import { FAKE_TENANT, FakeConsoleApi } from "../../test/fake-console-api.js";
import { renderConsole } from "../../test/render-console.js";
import { axe } from "../../ui/test-utils.js";

beforeEach(() => {
  window.localStorage.clear();
});

/** A running session with a full trace + usage, and an idle forked one. */
function fakeWithDetail(): FakeConsoleApi {
  const api = FakeConsoleApi.signedIn(["read"]);
  api.addSession({
    id: "sess_01AAA",
    title: "fix the login bug",
    status: "running",
    agentId: "agent_01CODER",
    agentVersion: 3,
    environmentId: "env_01CLOUD",
    createdAt: "2026-07-02T10:00:00.000Z",
    updatedAt: "2026-07-02T11:00:00.000Z",
    lastActivityAt: "2026-07-02T11:30:00.000Z",
  });
  api.addSession({
    id: "sess_01BBB",
    status: "idle",
    stopReason: "completed",
    forkedFromSessionId: "sess_01AAA",
  });
  api.usage.set("sess_01AAA", {
    inputTokens: 1234,
    outputTokens: 567,
    cacheCreationInputTokens: 10,
    cacheReadInputTokens: 20,
    usdCost: 0.1234,
  });
  api.entries.set("sess_01AAA", [
    {
      seq: 0,
      type: "user.message",
      processedAt: "2026-07-02T10:00:01.000Z",
      content: "Fix the login bug in auth.ts",
    },
    {
      seq: 1,
      type: "agent.tool_use",
      processedAt: "2026-07-02T10:00:02.000Z",
      tool: "bash",
      input: { command: "ls" },
    },
    {
      seq: 2,
      type: "agent.tool_result",
      processedAt: "2026-07-02T10:00:03.000Z",
      tool: "bash",
      output: "auth.ts\nlogin.ts",
      truncated: true,
    },
    {
      seq: 3,
      type: "session.status_idle",
      processedAt: "2026-07-02T10:00:04.000Z",
      stopReason: "requires_action",
      blockingEventIds: ["evt_01X", "evt_01Y"],
    },
    {
      seq: 4,
      type: "session.error",
      processedAt: "2026-07-02T10:00:05.000Z",
      mcpServerName: "github",
      retryStatus: "retrying",
    },
    {
      seq: 5,
      type: "agent.thinking",
      processedAt: null,
      signature: "abc123",
    },
  ]);
  return api;
}

async function renderDetail(
  api = fakeWithDetail(),
  id = "sess_01AAA",
): Promise<ReturnType<typeof renderConsole>> {
  const result = renderConsole(api, `/console/sessions/${id}`);
  await screen.findByRole("tablist", { name: "Session detail" });
  return result;
}

describe("session detail header (DP-1, W2 step 2)", () => {
  it("header leads with the DP-1 facts: status, agent@version, environment, cost", async () => {
    await renderDetail();
    expect(
      screen.getByRole("heading", { name: "fix the login bug" }),
    ).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByTitle("agent_01CODER")).toBeInTheDocument();
    expect(screen.getByText("@v3")).toBeInTheDocument();
    expect(screen.getByTitle("env_01CLOUD")).toBeInTheDocument();
    // §7.6: agent/environment ids link to their family routes until the
    // phase-3 detail routes exist (../resource-ids.tsx).
    expect(
      screen.getByRole("link", { name: /agent_01CODER/ }),
    ).toHaveAttribute("href", "/console/agents");
    expect(
      screen.getByRole("link", { name: /env_01CLOUD/ }),
    ).toHaveAttribute("href", "/console/resources");
    // Cost so far comes from GET …/usage (§9.9), formatted like v1.
    expect(await screen.findByText("$0.1234")).toBeInTheDocument();
  });

  it("shows the stop reason chip and falls back to the id as title", async () => {
    await renderDetail(fakeWithDetail(), "sess_01BBB");
    expect(
      screen.getByRole("heading", { name: "sess_01BBB" }),
    ).toBeInTheDocument();
    expect(screen.getByText("idle")).toBeInTheDocument();
    expect(screen.getByText("completed")).toBeInTheDocument();
  });

  it("meta lists timestamps and links the forked-from session (v1 parity)", async () => {
    await renderDetail(fakeWithDetail(), "sess_01BBB");
    expect(screen.getByText("Created")).toBeInTheDocument();
    expect(screen.getByText("Updated")).toBeInTheDocument();
    expect(screen.getByText("Last activity")).toBeInTheDocument();
    expect(screen.getByText("Forked from")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /sess_01AAA/ }),
    ).toHaveAttribute("href", "/console/sessions/sess_01AAA");
  });

  it("timestamps render in the v1 format", async () => {
    await renderDetail();
    expect(screen.getByText("2026-07-02 10:00:00Z")).toBeInTheDocument();
    expect(screen.getByText("2026-07-02 11:00:00Z")).toBeInTheDocument();
    expect(screen.getByText("2026-07-02 11:30:00Z")).toBeInTheDocument();
  });

  it("back link returns to the sessions list", async () => {
    await renderDetail();
    expect(screen.getByRole("link", { name: "← Sessions" })).toHaveAttribute(
      "href",
      "/console/sessions",
    );
  });

  it("a missing session renders the DP-9 facts", async () => {
    renderConsole(fakeWithDetail(), "/console/sessions/sess_01NOPE");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("not_found");
    expect(alert).toHaveTextContent("req_01TESTREQUEST");
  });
});

describe("tabs (§7.3)", () => {
  it("shows Trace (default), Tree, Usage, Outputs, Conversation (§7.3 order)", async () => {
    await renderDetail();
    const tablist = screen.getByRole("tablist", { name: "Session detail" });
    const tabs = within(tablist)
      .getAllByRole("tab")
      .map((t) => t.textContent);
    expect(tabs).toEqual(["Trace", "Tree", "Usage", "Outputs", "Conversation"]);
    expect(within(tablist).getByRole("tab", { name: "Trace" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

describe("Fork action (WP-C2.3, W6)", () => {
  it("read scope: Fork is disabled with an explanation (§6.1)", async () => {
    await renderDetail();
    const button = screen.getByRole("button", { name: "Fork" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("requires the write scope");
  });

  it("write scope: fork toasts, links the new session, and shows the CLI resume command (§1.4)", async () => {
    const user = userEvent.setup();
    const api = fakeWithDetail();
    api.signedIn = { scopes: ["read", "write"], tenant: FAKE_TENANT };
    await renderDetail(api);

    await user.click(screen.getByRole("button", { name: "Fork" }));

    // The wire call is the fork route on the viewed session.
    expect(api.calls).toContainEqual({
      method: "POST",
      path: "/v1/sessions/sess_01AAA/fork",
      body: {},
    });
    // Success toast + the inline notice with the deep link.
    expect(await screen.findByText(/Forked — new session sess_01FORKED/))
      .toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /sess_01FORKED/ }),
    ).toHaveAttribute("href", "/console/sessions/sess_01FORKED");
    // The CLI-preferred follow-up (fork → resume, §1.4/§10.4) — real command
    // form from the client extension, with a copy affordance.
    expect(
      screen.getByText("/remote:resume sess_01FORKED"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Copy command: /remote:resume sess_01FORKED",
      }),
    ).toBeInTheDocument();
  });

  it("fork failure renders the DP-9 facts inline", async () => {
    const user = userEvent.setup();
    const api = fakeWithDetail();
    api.signedIn = { scopes: ["read", "write"], tenant: FAKE_TENANT };
    await renderDetail(api);

    // The fork target vanishes server-side after render (e.g. deleted from
    // another client): the POST answers a real-shaped 404 envelope.
    api.sessions = [];
    await user.click(screen.getByRole("button", { name: "Fork" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("not_found");
    expect(alert).toHaveTextContent("req_01TESTREQUEST");
  });
});

describe("Trace tab (§7.4, W2 step 3)", () => {
  it("Trace tab renders the entries chronologically with seq/type/time heads", async () => {
    await renderDetail();
    const list = await screen.findByRole("list", { name: "Session events" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(6);
    expect(items[0]).toHaveTextContent("#0");
    expect(items[0]).toHaveTextContent("user.message");
    expect(items[0]).toHaveTextContent("2026-07-02 10:00:01Z");
    expect(items[5]).toHaveTextContent("#5");
  });

  it("tool executions render name, collapsed input/output (DP-2) and the truncation flag", async () => {
    const user = userEvent.setup();
    await renderDetail();
    const list = await screen.findByRole("list", { name: "Session events" });
    const [, toolUse, toolResult] = within(list).getAllByRole("listitem");

    expect(toolUse).toHaveTextContent("tool: bash");
    const inputToggle = within(toolUse!).getByRole("button", {
      name: /input/,
    });
    expect(inputToggle).toHaveAttribute("aria-expanded", "false");
    expect(within(toolUse!).queryByText(/"command"/)).not.toBeInTheDocument();
    await user.click(inputToggle);
    expect(within(toolUse!).getByText(/"command": "ls"/)).toBeInTheDocument();

    expect(toolResult).toHaveTextContent("tool: bash");
    expect(toolResult).toHaveTextContent("(truncated)");
    const outputToggle = within(toolResult!).getByRole("button", {
      name: /output/,
    });
    await user.click(outputToggle);
    expect(outputToggle).toHaveAttribute("aria-expanded", "true");
    // Short string payloads also preview in the collapsed summary, so the
    // full text appears twice once expanded (summary + payload).
    expect(
      within(toolResult!).getAllByText(/auth\.ts/).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("lifecycle entries render their crucial fields (v1 parity)", async () => {
    await renderDetail();
    const list = await screen.findByRole("list", { name: "Session events" });
    expect(list).toHaveTextContent("stopReason: requires_action");
    expect(list).toHaveTextContent("blockingEventIds: evt_01X, evt_01Y");
    expect(list).toHaveTextContent("mcpServerName: github");
    expect(list).toHaveTextContent("retryStatus: retrying");
  });

  it("content and generic payloads: text inline, unknown types as collapsed JSON", async () => {
    const user = userEvent.setup();
    await renderDetail();
    const list = await screen.findByRole("list", { name: "Session events" });
    expect(list).toHaveTextContent("Fix the login bug in auth.ts");

    const generic = within(list).getAllByRole("listitem")[5]!;
    const payloadToggle = within(generic).getByRole("button", {
      name: /payload/,
    });
    expect(within(generic).queryByText(/"signature"/)).not.toBeInTheDocument();
    await user.click(payloadToggle);
    expect(
      within(generic).getByText(/"signature": "abc123"/),
    ).toBeInTheDocument();
  });

  it("filters by event type", async () => {
    const user = userEvent.setup();
    await renderDetail();
    await screen.findByRole("list", { name: "Session events" });

    await user.selectOptions(
      screen.getByLabelText("Event type"),
      "agent.tool_use",
    );
    const list = screen.getByRole("list", { name: "Session events" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(list).toHaveTextContent("agent.tool_use");
    expect(list).not.toHaveTextContent("user.message");
  });

  it("Refresh re-reads the entries (manual — live tail is phase 2)", async () => {
    const user = userEvent.setup();
    const api = fakeWithDetail();
    await renderDetail(api);
    await screen.findByRole("list", { name: "Session events" });

    api.entries.get("sess_01AAA")!.push({
      seq: 6,
      type: "agent.message",
      processedAt: "2026-07-02T10:00:06.000Z",
      content: "Done.",
    });
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Done.")).toBeInTheDocument();
  });

  it("empty trace teaches what fills it (v1 parity item 17)", async () => {
    await renderDetail(fakeWithDetail(), "sess_01BBB");
    expect(
      await screen.findByText(/No events yet/),
    ).toBeInTheDocument();
  });

  it("entries failure shows a banner; the header still works (v1 parity item 18)", async () => {
    const api = fakeWithDetail();
    api.failGets.set(
      "/v1/sessions/sess_01AAA/entries",
      new ConsoleApiError("boom", {
        status: 500,
        code: "internal_error",
        requestId: "req_01ERR",
      }),
    );
    await renderDetail(api);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("internal_error");
    expect(alert).toHaveTextContent("req_01ERR");
    // Partial failure: the DP-1 header is intact.
    expect(
      screen.getByRole("heading", { name: "fix the login bug" }),
    ).toBeInTheDocument();
  });
});

describe("Usage tab (§9.9 minimal, W2 step 4)", () => {
  it("Usage tab shows the token counters and the USD cost", async () => {
    const user = userEvent.setup();
    await renderDetail();
    await user.click(screen.getByRole("tab", { name: "Usage" }));

    const panel = screen.getByRole("tabpanel");
    const row = (label: string) =>
      within(panel).getByText(label).parentElement!;
    expect(row("Input tokens")).toHaveTextContent("1234");
    expect(row("Output tokens")).toHaveTextContent("567");
    expect(row("Cache creation input tokens")).toHaveTextContent("10");
    expect(row("Cache read input tokens")).toHaveTextContent("20");
    expect(row("USD cost")).toHaveTextContent("$0.1234");
  });

  it("usage failure is partial: header cost shows — and the tab explains (v1 parity item 10)", async () => {
    const user = userEvent.setup();
    const api = fakeWithDetail();
    api.failGets.set(
      "/v1/sessions/sess_01AAA/usage",
      new ConsoleApiError("usage unavailable", {
        status: 500,
        code: "internal_error",
        requestId: "req_01USAGE",
      }),
    );
    await renderDetail(api);
    expect(screen.getByText("cost so far").parentElement).toHaveTextContent(
      "—",
    );

    await user.click(screen.getByRole("tab", { name: "Usage" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("internal_error");
    expect(alert).toHaveTextContent("req_01USAGE");
  });
});

describe("recents + favorites (§7.2 — per-browser state)", () => {
  it("visiting a session records it as a recent", async () => {
    await renderDetail();
    const recents = JSON.parse(
      window.localStorage.getItem("pi-console.recent-sessions") ?? "[]",
    ) as Array<{ id: string; title?: string }>;
    expect(recents).toEqual([
      { id: "sess_01AAA", title: "fix the login bug" },
    ]);
  });

  it("Favorite toggles per-browser persistence and never touches the API", async () => {
    const user = userEvent.setup();
    const api = fakeWithDetail();
    await renderDetail(api);
    const callsBefore = api.calls.length;

    await user.click(screen.getByRole("button", { name: "Favorite" }));
    expect(
      JSON.parse(
        window.localStorage.getItem("pi-console.favorite-sessions") ?? "[]",
      ),
    ).toEqual([{ id: "sess_01AAA", title: "fix the login bug" }]);

    await user.click(screen.getByRole("button", { name: "Unfavorite" }));
    expect(
      window.localStorage.getItem("pi-console.favorite-sessions"),
    ).toBe("[]");
    expect(api.calls.length).toBe(callsBefore);
  });
});

describe("interaction surfaces (F4 — no duplicate composer/blocking)", () => {
  it("the W4 interact panel shows off the Conversation tab and hides on it", async () => {
    const user = userEvent.setup();
    // sess_01AAA is running → the interact panel renders its steering row.
    await renderDetail(); // default Trace tab

    expect(
      screen.getByRole("region", { name: "Session controls" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Composer" }),
    ).not.toBeInTheDocument();

    // On the Conversation tab the composer owns interaction: the interact
    // panel hides so there is no second user.message input / landmark.
    await user.click(screen.getByRole("tab", { name: "Conversation" }));
    expect(
      await screen.findByRole("region", { name: "Composer" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Session controls" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByLabelText("Message")).toHaveLength(1);

    // Back on Trace the interact panel returns (Tree/Usage/Outputs keep it).
    await user.click(screen.getByRole("tab", { name: "Trace" }));
    expect(
      screen.getByRole("region", { name: "Session controls" }),
    ).toBeInTheDocument();
  });

  it("requires_action: exactly one Blocking-requests group on Conversation", async () => {
    const user = userEvent.setup();
    const api = FakeConsoleApi.signedIn(["read", "write"]);
    api.addSession({
      id: "sess_01RA",
      status: "idle",
      stopReason: "requires_action",
    });
    api.entries.set("sess_01RA", [
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
    renderConsole(api, "/console/sessions/sess_01RA");
    await screen.findByRole("tablist", { name: "Session detail" });

    // Trace tab: the blocking group comes from the W4 interact panel (one).
    expect(
      screen.getAllByRole("group", { name: "Blocking requests" }),
    ).toHaveLength(1);

    // Conversation tab: still exactly one (the composer's) — NOT the pre-F4
    // pair of the interact panel's group plus the composer's.
    await user.click(screen.getByRole("tab", { name: "Conversation" }));
    await screen.findByRole("region", { name: "Composer" });
    expect(
      screen.getAllByRole("group", { name: "Blocking requests" }),
    ).toHaveLength(1);
  });
});

describe("accessibility", () => {
  it("is axe-clean", async () => {
    const { view } = await renderDetail();
    await screen.findByRole("list", { name: "Session events" });
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
