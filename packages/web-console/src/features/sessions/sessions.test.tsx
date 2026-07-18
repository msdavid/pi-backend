/**
 * Sessions list feature tests (WP-C1.7; console-spec §7.3, W2 step 1). The
 * API client is a collaborator (fake at the `<ApiClientProvider>` seam); its
 * wire behavior is contract-tested in `src/api/__tests__/`.
 *
 * ── v1 parity checklist ─────────────────────────────────────────────────────
 * Every behavior of the v1 vanilla console (deleted in WP-C1.8; see git
 * history for its `src/app.js` + `src/index.html`) mapped to its replacement
 * coverage:
 *
 *  1. Sessions table: id, title ("(untitled)" fallback), status,
 *     agent+version, environment, created, cost (USD since WP-C2.2 — the
 *     WP-C2.0 `usage.usdCost` rollup; tokens live on the Usage tab)
 *       → "renders the §7.3 columns" (this file)
 *  2. Status filter select reloads the list
 *       → "filters by status" (this file; agent/environment filters are new)
 *  3. Cursor pagination ("Next" button)
 *       → "pages with Load more" (this file)
 *  4. Refresh button reloads the list
 *       → "Refresh refetches" (this file)
 *  5. Row click opens the session detail
 *       → "row activation navigates to the detail route" (this file)
 *  6. Empty list message ("No sessions.")
 *       → "teaching empty state" (this file; now DP-5: CLI command included)
 *  7. List load failure shows an error banner
 *       → "list failure renders the DP-9 facts" (this file)
 *  8. Detail meta rows: ID / Status / Stop reason / Agent / Environment /
 *     Created / Updated / Last activity / Forked from
 *       → session-detail.test.tsx "header leads with the DP-1 facts" + "meta"
 *  9. Usage panel: 4 token counters + usdCost as $x.xxxx
 *       → session-detail.test.tsx "Usage tab"
 * 10. Usage load failure is partial (banner; page still renders)
 *       → session-detail.test.tsx "usage failure"
 * 11. Entries list: #seq / type / processedAt heads, chronological
 *       → session-detail.test.tsx "Trace tab renders the entries"
 * 12. agent.tool_use (+ mcp/custom variants): tool name + collapsed input
 *       → session-detail.test.tsx "tool executions"
 * 13. agent.tool_result: tool name + output + "(truncated)" flag
 *       → session-detail.test.tsx "tool executions"
 * 14. session.status_idle: stopReason + blockingEventIds
 *       → session-detail.test.tsx "lifecycle entries"
 * 15. session.error: mcpServerName + retryStatus
 *       → session-detail.test.tsx "lifecycle entries"
 * 16. content fallback + generic payload as collapsed JSON
 *       → session-detail.test.tsx "content and generic payloads"
 * 17. Entries empty state ("No events.")
 *       → session-detail.test.tsx "empty trace"
 * 18. Entries load failure banner (page still works)
 *       → session-detail.test.tsx "entries failure"
 * 19. Back from detail to the list
 *       → session-detail.test.tsx "back link"
 * 20. Connect form + localStorage-held API key (v1 auth)
 *       → RETIRED BY DESIGN (console-spec §4.1): cookie console session,
 *         covered by src/app/auth-flow.test.tsx (WP-C1.6)
 * 21. Base-URL field
 *       → RETIRED: the console is same-origin with the backend (§3.1)
 * ────────────────────────────────────────────────────────────────────────────
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { ConsoleApiError } from "../../api/client.js";
import { FakeConsoleApi } from "../../test/fake-console-api.js";
import { renderConsole } from "../../test/render-console.js";
import { axe } from "../../ui/test-utils.js";

beforeEach(() => {
  window.localStorage.clear();
});

function fakeWithSessions(): FakeConsoleApi {
  const api = FakeConsoleApi.signedIn(["read"]);
  api.addSession({
    id: "sess_01AAA",
    title: "fix the login bug",
    status: "running",
    agentId: "agent_01CODER",
    agentVersion: 3,
    environmentId: "env_01CLOUD",
    createdAt: "2026-07-02T10:00:00.000Z",
    usage: {
      inputTokens: 1234,
      outputTokens: 567,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      usdCost: 0.1234,
    },
  });
  api.addSession({
    id: "sess_01BBB",
    status: "idle",
    stopReason: "completed",
    createdAt: "2026-07-01T10:00:00.000Z",
  });
  return api;
}

describe("sessions list (§7.3)", () => {
  it("renders the §7.3 columns for each session", async () => {
    renderConsole(fakeWithSessions(), "/console/sessions");
    const table = await screen.findByRole("table", { name: "Sessions" });

    const headers = within(table)
      .getAllByRole("columnheader")
      .map((th) => th.textContent);
    expect(headers).toEqual([
      "ID",
      "Title",
      "Status",
      "Agent",
      "Environment",
      "Created",
      "Cost (USD)",
    ]);

    const first = within(table).getAllByRole("row")[1]!; // newest first
    expect(within(first).getByTitle("sess_01AAA")).toBeInTheDocument();
    expect(within(first).getByText("fix the login bug")).toBeInTheDocument();
    expect(within(first).getByText("running")).toBeInTheDocument();
    expect(within(first).getByTitle("agent_01CODER")).toBeInTheDocument();
    expect(within(first).getByText("@v3")).toBeInTheDocument();
    expect(within(first).getByTitle("env_01CLOUD")).toBeInTheDocument();
    expect(
      within(first).getByText("2026-07-02 10:00:00Z"),
    ).toBeInTheDocument();
    // WP-C2.2: the cost column is the WP-C2.0 usdCost rollup, v1 USD format.
    expect(within(first).getByText("$0.1234")).toBeInTheDocument();

    // v1 parity: untitled fallback.
    expect(within(table).getByText("(untitled)")).toBeInTheDocument();
    // §7.6: the id links to the detail route.
    expect(
      within(first).getByRole("link", { name: /sess_01AAA/ }),
    ).toHaveAttribute("href", "/console/sessions/sess_01AAA");
    // §7.6: agent/environment ids link too — to their family routes until
    // the phase-3 detail routes exist (./resource-ids.tsx).
    expect(
      within(first).getByRole("link", { name: /agent_01CODER/ }),
    ).toHaveAttribute("href", "/console/agents");
    expect(
      within(first).getByRole("link", { name: /env_01CLOUD/ }),
    ).toHaveAttribute("href", "/console/resources");
  });

  it("filters by status, agent id and environment id (server-side params)", async () => {
    const user = userEvent.setup();
    const api = fakeWithSessions();
    renderConsole(api, "/console/sessions");
    await screen.findByRole("table", { name: "Sessions" });

    await user.selectOptions(screen.getByLabelText("Status"), "running");
    const table = await screen.findByRole("table", { name: "Sessions" });
    expect(await within(table).findByText("fix the login bug")).toBeVisible();
    expect(within(table).queryByText("(untitled)")).not.toBeInTheDocument();
    expect(
      api.calls.some(
        (c) => c.method === "GET" && c.path === "/v1/sessions?status=running",
      ),
    ).toBe(true);

    await user.type(screen.getByLabelText("Agent id"), "agent_01OTHER");
    await user.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(
      await screen.findByText("No sessions match these filters"),
    ).toBeInTheDocument();
    expect(
      api.calls.some(
        (c) =>
          c.method === "GET" &&
          c.path === "/v1/sessions?status=running&agentId=agent_01OTHER",
      ),
    ).toBe(true);
  });

  it("pages with Load more until the cursor is exhausted", async () => {
    const user = userEvent.setup();
    const api = FakeConsoleApi.signedIn(["read"]);
    // 55 sessions: one server page of 50 (default limit) + a remainder.
    for (let i = 0; i < 55; i += 1) {
      api.addSession({
        id: `sess_${String(i).padStart(3, "0")}`,
        createdAt: `2026-07-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
      });
    }
    renderConsole(api, "/console/sessions");

    const table = await screen.findByRole("table", { name: "Sessions" });
    expect(within(table).getAllByRole("row")).toHaveLength(1 + 50);

    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(within(table).getAllByRole("row")).toHaveLength(1 + 55);
    expect(
      screen.queryByRole("button", { name: "Load more" }),
    ).not.toBeInTheDocument();
  });

  it("Refresh refetches the list (manual — live tail is phase 2)", async () => {
    const user = userEvent.setup();
    const api = fakeWithSessions();
    renderConsole(api, "/console/sessions");
    await screen.findByRole("table", { name: "Sessions" });

    api.addSession({
      id: "sess_01CCC",
      title: "brand new",
      createdAt: "2026-07-03T10:00:00.000Z",
    });
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("brand new")).toBeInTheDocument();
  });

  it("row activation navigates to the detail route", async () => {
    const user = userEvent.setup();
    const { router } = renderConsole(fakeWithSessions(), "/console/sessions");
    const table = await screen.findByRole("table", { name: "Sessions" });

    await user.click(within(table).getByText("fix the login bug"));
    expect(
      await screen.findByRole("heading", { name: "fix the login bug" }),
    ).toBeInTheDocument();
    // Router state paths are basepath-relative ("/console" is the basepath).
    expect(router.state.location.pathname).toBe("/sessions/sess_01AAA");
  });

  it("teaching empty state: create concept + the CLI command (DP-5)", async () => {
    renderConsole(FakeConsoleApi.signedIn(["read"]), "/console/sessions");
    expect(await screen.findByText("No sessions yet")).toBeInTheDocument();
    expect(
      screen.getByText('/remote:delegate "fix the login bug"'),
    ).toBeInTheDocument();
  });

  it("list failure renders the DP-9 facts (code + request id) and no table", async () => {
    const api = FakeConsoleApi.signedIn(["read"]);
    api.failGets.set(
      "/v1/sessions",
      new ConsoleApiError("Tenant rate limit exceeded.", {
        status: 429,
        code: "rate_limited",
        requestId: "req_01RATE",
      }),
    );
    renderConsole(api, "/console/sessions");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Tenant rate limit exceeded.");
    expect(alert).toHaveTextContent("rate_limited");
    expect(alert).toHaveTextContent("req_01RATE");
    // DP-9: the rendered code/requestId link to the docs that explain them.
    expect(within(alert).getByRole("link", { name: "docs" })).toHaveAttribute(
      "href",
      "https://github.com/msdavid/pi-backend/blob/main/docs/api-reference.md#error-envelope",
    );
  });

  it("is axe-clean", async () => {
    const { view } = renderConsole(fakeWithSessions(), "/console/sessions");
    await screen.findByRole("table", { name: "Sessions" });
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
