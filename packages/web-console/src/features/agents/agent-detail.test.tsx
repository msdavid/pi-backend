/**
 * Agent detail feature tests (WP-C3.1; console-spec §9.1, journeys W10 +
 * W16): readable definition with per-tool permission policies, browsable
 * version history, PATCH-creates-version copy, and the DP-7 archive dialog
 * whose consequence names the count of scheduled jobs it auto-archives.
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { FakeConsoleApi } from "../../test/fake-console-api.js";
import { renderConsole } from "../../test/render-console.js";
import { axe } from "../../ui/test-utils.js";

beforeEach(() => {
  window.localStorage.clear();
});

const AGENT_ID = "agent_01TESTAGENT";

function fakeWithAgent(scopes: string[] = ["admin"]): FakeConsoleApi {
  const api = FakeConsoleApi.signedIn(scopes);
  api.addAgent({
    id: AGENT_ID,
    name: "code-reviewer",
    currentVersion: 2,
    config: {
      model: {
        provider: "anthropic",
        id: "claude-sonnet-4",
        thinkingLevel: "high",
      },
      systemPrompt: "Review with care.",
      tools: {
        defaultConfig: { enabled: true, permissionPolicy: "always_allow" },
        configs: {
          bash: { permissionPolicy: "always_ask" },
          browser: { enabled: false, permissionPolicy: "always_deny" },
        },
      },
    },
  });
  api.addAgentVersion(AGENT_ID, {
    version: 1,
    config: { model: { provider: "anthropic", id: "claude-sonnet-4" } },
    createdAt: "2026-06-01T00:00:00.000Z",
  });
  api.addAgentVersion(AGENT_ID, {
    version: 2,
    config: {
      model: { provider: "anthropic", id: "claude-sonnet-4" },
      systemPrompt: "Review with care.",
    },
    createdAt: "2026-07-01T00:00:00.000Z",
  });
  return api;
}

describe("agent detail (§9.1, W10/W16)", () => {
  it("renders the definition readably: model, prompt, per-tool permission policies with microcopy", async () => {
    renderConsole(fakeWithAgent(), `/console/agents/${AGENT_ID}`);
    expect(
      await screen.findByRole("heading", { name: "code-reviewer" }),
    ).toBeInTheDocument();

    expect(
      screen.getByText("anthropic / claude-sonnet-4"),
    ).toBeInTheDocument();
    expect(screen.getByText(/thinking: high/)).toBeInTheDocument();

    // W16 governance view: default + per-tool rows, policy + explanation.
    const tools = screen.getByRole("table", { name: "Tool permissions" });
    const [defaults, bash, browser] = within(tools)
      .getAllByRole("row")
      .slice(1);
    expect(within(defaults!).getByText("all tools (default)")).toBeInTheDocument();
    expect(within(defaults!).getByText("always_allow")).toBeInTheDocument();
    expect(
      within(defaults!).getByText("runs without asking"),
    ).toBeInTheDocument();
    expect(within(bash!).getByText("bash")).toBeInTheDocument();
    expect(within(bash!).getByText("always_ask")).toBeInTheDocument();
    expect(
      within(bash!).getByText("each call needs a human confirmation"),
    ).toBeInTheDocument();
    expect(within(bash!).getByText("inherits the default")).toBeInTheDocument();
    expect(within(browser!).getByText("no")).toBeInTheDocument();
    expect(within(browser!).getByText("always_deny")).toBeInTheDocument();
    expect(
      within(browser!).getByText("calls are blocked"),
    ).toBeInTheDocument();
  });

  it("deep-links to the sessions list filtered by this agent (§7.6/W10)", async () => {
    renderConsole(fakeWithAgent(), `/console/agents/${AGENT_ID}`);
    const link = await screen.findByRole("link", {
      name: /Sessions using this agent/,
    });
    expect(link.getAttribute("href")).toContain("/sessions");
    expect(link.getAttribute("href")).toContain(`agentId=${AGENT_ID}`);
  });

  it("version history is browsable and each version's config viewable", async () => {
    const user = userEvent.setup();
    renderConsole(fakeWithAgent(), `/console/agents/${AGENT_ID}`);
    await screen.findByRole("heading", { name: "Version history" });

    // Newest first, the current one badged.
    const list = await screen.findByRole("list", { name: "Version history" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows[0]!.textContent).toContain("v2");
    expect(within(rows[0]!).getByText("current")).toBeInTheDocument();
    expect(rows[1]!.textContent).toContain("v1");

    // Each version's config expands in place (DP-2: lazily).
    const toggles = within(list).getAllByRole("button", { name: /config/ });
    expect(toggles).toHaveLength(2);
    await user.click(toggles[1]!);
    expect(rows[1]!.textContent).toContain("claude-sonnet-4");
  });

  it("read scope: Edit and Archive are disabled with the reason inline (§6.1)", async () => {
    renderConsole(fakeWithAgent(["read"]), `/console/agents/${AGENT_ID}`);
    await screen.findByRole("heading", { name: "code-reviewer" });

    const edit = screen.getByRole("button", { name: "Edit" });
    const archive = screen.getByRole("button", { name: "Archive" });
    expect(edit).toBeDisabled();
    expect(archive).toBeDisabled();
    expect(edit).toHaveAccessibleDescription("requires the write scope");
    expect(archive).toHaveAccessibleDescription("requires the write scope");
  });

  it("write scope: Edit and Archive are enabled (§6.2 — write, not admin, is the bar)", async () => {
    renderConsole(fakeWithAgent(["read", "write"]), `/console/agents/${AGENT_ID}`);
    await screen.findByRole("heading", { name: "code-reviewer" });

    expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Archive" })).toBeEnabled();
  });

  it("archived agents are read-only: actions disabled with the terminal reason", async () => {
    const api = FakeConsoleApi.signedIn(["admin"]);
    api.addAgent({ id: AGENT_ID, name: "code-reviewer", status: "archived" });
    renderConsole(api, `/console/agents/${AGENT_ID}`);
    await screen.findByRole("heading", { name: "code-reviewer" });

    const edit = screen.getByRole("button", { name: "Edit" });
    expect(edit).toBeDisabled();
    expect(edit).toHaveAccessibleDescription(
      "this agent is archived — archival is terminal and read-only",
    );
    expect(screen.getByRole("button", { name: "Archive" })).toBeDisabled();
  });

  it("edit says plainly that PATCH creates version n+1 and running sessions keep theirs (§9.1)", async () => {
    const user = userEvent.setup();
    const api = fakeWithAgent();
    renderConsole(api, `/console/agents/${AGENT_ID}`);
    await screen.findByRole("heading", { name: "code-reviewer" });

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Edit code-reviewer",
    });
    // The §9.1 normative copy, stated before anything is saved.
    expect(
      within(dialog).getByText(/Saving creates version 3/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/running keep the version they started with/),
    ).toBeInTheDocument();

    // Prefilled from the current version.
    const prompt = within(dialog).getByLabelText("System prompt");
    expect(prompt).toHaveValue("Review with care.");
    await user.clear(prompt);
    await user.type(prompt, "Review faster.");
    await user.click(
      within(dialog).getByRole("button", { name: "Save as v3" }),
    );

    const patch = api.calls.find(
      (call) =>
        call.method === "PATCH" && call.path === `/v1/agents/${AGENT_ID}`,
    );
    expect(patch?.body).toMatchObject({
      name: "code-reviewer",
      systemPrompt: "Review faster.",
    });
    // The bumped version renders once the invalidated detail refetches.
    expect((await screen.findAllByText("v3")).length).toBeGreaterThan(0);
  });

  it("archive: DP-7 dialog names the real consequence — the count of scheduled jobs auto-archived", async () => {
    const user = userEvent.setup();
    const api = fakeWithAgent();
    // Two live jobs reference the agent (bare-id and pinned forms); another
    // agent's job must not count. (Archived jobs never appear on job reads.)
    api.addJob({ id: "job_01BYID", name: "by-id", agent: AGENT_ID });
    api.addJob({
      id: "job_01PINNED",
      name: "pinned",
      agent: { id: AGENT_ID, version: 1 },
    });
    api.addJob({ id: "job_01OTHER", name: "other", agent: "agent_01OTHER" });
    renderConsole(api, `/console/agents/${AGENT_ID}`);
    await screen.findByRole("heading", { name: "code-reviewer" });

    await user.click(screen.getByRole("button", { name: "Archive" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Archive code-reviewer",
    });
    expect(
      await within(dialog).findByText(
        /auto-archives the 2 scheduled jobs referencing this agent/,
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/Archival is terminal/)).toBeInTheDocument();

    // Typed confirmation (DP-7): the destructive button arms on exact name.
    const confirm = within(dialog).getByRole("button", {
      name: "Archive agent",
    });
    expect(confirm).toBeDisabled();
    await user.type(
      within(dialog).getByLabelText('Type "code-reviewer" to confirm'),
      "code-reviewer",
    );
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    expect(
      api.calls.some(
        (call) =>
          call.method === "POST" &&
          call.path === `/v1/agents/${AGENT_ID}/archive`,
      ),
    ).toBe(true);
    // Terminal state reflected in place.
    expect(await screen.findByText("archived")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
  });

  it("is axe-clean", async () => {
    const { view } = renderConsole(fakeWithAgent(), `/console/agents/${AGENT_ID}`);
    await screen.findByRole("heading", { name: "code-reviewer" });
    await screen.findByRole("table", { name: "Tool permissions" });
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
