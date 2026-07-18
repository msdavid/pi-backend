/**
 * Agents list feature tests (WP-C3.1; console-spec §9.1, journey W10). The
 * API client is a collaborator (fake at the `<ApiClientProvider>` seam); its
 * wire behavior is contract-tested in `src/api/__tests__/`.
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

function fakeWithAgents(scopes: string[] = ["admin"]): FakeConsoleApi {
  const api = FakeConsoleApi.signedIn(scopes);
  api.addAgent({ id: "agent_01TESTAGENT", name: "code-reviewer" });
  api.addAgent({
    id: "agent_01TESTOLD",
    name: "retired-helper",
    status: "archived",
    currentVersion: 4,
    updatedAt: "2026-07-10T08:00:00.000Z",
  });
  return api;
}

describe("agents list (§9.1, W10)", () => {
  it("renders the columns: name, version, status, updated", async () => {
    renderConsole(fakeWithAgents(), "/console/agents");
    const table = await screen.findByRole("table", { name: "Agents" });

    const headers = within(table)
      .getAllByRole("columnheader")
      .map((th) => th.textContent);
    expect(headers).toEqual(["Name", "Version", "Status", "Updated"]);

    const [reviewer, retired] = within(table).getAllByRole("row").slice(1);
    expect(within(reviewer!).getByText("code-reviewer")).toBeInTheDocument();
    expect(within(reviewer!).getByText("v1")).toBeInTheDocument();
    expect(within(reviewer!).getByText("active")).toBeInTheDocument();
    expect(within(retired!).getByText("retired-helper")).toBeInTheDocument();
    expect(within(retired!).getByText("v4")).toBeInTheDocument();
    expect(within(retired!).getByText("archived")).toBeInTheDocument();
    expect(
      within(retired!).getByText("2026-07-10 08:00:00Z"),
    ).toBeInTheDocument();
  });

  it("filters by exact name server-side (fake narrows the result set)", async () => {
    const user = userEvent.setup();
    renderConsole(fakeWithAgents(), "/console/agents");
    await screen.findByRole("table", { name: "Agents" });

    await user.type(screen.getByLabelText("Name"), "retired-helper");
    await user.click(screen.getByRole("button", { name: "Apply filter" }));

    const table = await screen.findByRole("table", { name: "Agents" });
    expect(
      await within(table).findByText("retired-helper"),
    ).toBeInTheDocument();
    expect(within(table).queryByText("code-reviewer")).not.toBeInTheDocument();
  });

  it("row activation navigates to the agent detail route", async () => {
    const user = userEvent.setup();
    const { router } = renderConsole(fakeWithAgents(), "/console/agents");
    const table = await screen.findByRole("table", { name: "Agents" });

    await user.click(within(table).getByText("code-reviewer"));
    expect(router.state.location.pathname).toBe("/agents/agent_01TESTAGENT");
  });

  it("teaching empty state carries the API-equivalent command (DP-5) and the admin create flow", async () => {
    renderConsole(FakeConsoleApi.signedIn(["admin"]), "/console/agents");
    expect(await screen.findByText("No agents yet")).toBeInTheDocument();
    // A WORKING command: the backend hard-requires the bearer and the
    // Idempotency-Key, and JSON needs its content type (curl -d defaults
    // to urlencoded).
    const taught = screen.getByText(/curl -X POST .*\/v1\/agents/);
    expect(taught.textContent).toContain("Authorization: Bearer");
    expect(taught.textContent).toContain("Idempotency-Key:");
    expect(taught.textContent).toContain("Content-Type: application/json");
    // Create flow inside the empty state (scope permitting, §7.7).
    const emptyState = screen.getByText("No agents yet").closest("section");
    expect(
      within(emptyState as HTMLElement).getByRole("button", {
        name: "New agent",
      }),
    ).toBeEnabled();
  });

  it("read scope: New agent is disabled with the reason inline (§6.1); the empty state offers no create", async () => {
    renderConsole(FakeConsoleApi.signedIn(["read"]), "/console/agents");
    await screen.findByText("No agents yet");

    const createButton = screen.getByRole("button", { name: "New agent" });
    expect(createButton).toBeDisabled();
    // §6.2: the reason names the scope the backend ACTUALLY requires.
    expect(createButton).toHaveAccessibleDescription(
      "requires the write scope",
    );
    expect(screen.getAllByRole("button", { name: "New agent" })).toHaveLength(1);
  });

  it("write scope enables create (§6.2: resource management is a write surface)", async () => {
    renderConsole(FakeConsoleApi.signedIn(["read", "write"]), "/console/agents");
    await screen.findByText("No agents yet");
    // Header button AND the empty state's create flow (write unlocks both).
    const buttons = screen.getAllByRole("button", { name: "New agent" });
    expect(buttons).toHaveLength(2);
    for (const button of buttons) expect(button).toBeEnabled();
  });

  it("admin: create dialog submits the AgentCreate body and lands on the new detail", async () => {
    const user = userEvent.setup();
    const api = fakeWithAgents();
    const { router } = renderConsole(api, "/console/agents");
    await screen.findByRole("table", { name: "Agents" });

    await user.click(screen.getByRole("button", { name: "New agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New agent" });
    await user.type(within(dialog).getByLabelText("Name"), "docs-writer");
    await user.type(
      within(dialog).getByLabelText("Model provider"),
      "anthropic",
    );
    await user.type(
      within(dialog).getByLabelText("Model id"),
      "claude-sonnet-4",
    );
    await user.type(
      within(dialog).getByLabelText("System prompt"),
      "Write the docs.",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Create agent" }),
    );

    const post = api.calls.find(
      (call) => call.method === "POST" && call.path === "/v1/agents",
    );
    expect(post?.body).toEqual({
      name: "docs-writer",
      model: { provider: "anthropic", id: "claude-sonnet-4" },
      systemPrompt: "Write the docs.",
    });
    // Success lands on the created agent's detail route.
    expect(
      await screen.findByRole("heading", { name: "docs-writer" }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toMatch(/^\/agents\/agent_/);
  });

  it("create validation comes from the contracts zod issues; nothing is submitted", async () => {
    const user = userEvent.setup();
    const api = fakeWithAgents();
    renderConsole(api, "/console/agents");
    await screen.findByRole("table", { name: "Agents" });

    await user.click(screen.getByRole("button", { name: "New agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New agent" });
    // Empty name violates the contracts `Name` schema.
    await user.click(
      within(dialog).getByRole("button", { name: "Create agent" }),
    );
    expect(within(dialog).getByLabelText("Name")).toHaveAttribute(
      "aria-invalid",
      "true",
    );

    // A schema violation inside the advanced JSON surfaces path-prefixed.
    await user.type(within(dialog).getByLabelText("Name"), "docs-writer");
    await user.type(within(dialog).getByLabelText("Model provider"), "x");
    await user.type(within(dialog).getByLabelText("Model id"), "y");
    await user.type(
      within(dialog).getByLabelText("Advanced config (JSON)"),
      '{{"skills": "nope"}',
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Create agent" }),
    );
    expect(within(dialog).getByText(/^skills:/)).toBeInTheDocument();

    // Malformed JSON gets its own honest message.
    await user.clear(within(dialog).getByLabelText("Advanced config (JSON)"));
    await user.type(
      within(dialog).getByLabelText("Advanced config (JSON)"),
      "{{not json",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Create agent" }),
    );
    expect(
      within(dialog).getByText("advanced config is not valid JSON"),
    ).toBeInTheDocument();

    expect(
      api.calls.filter((call) => call.method === "POST"),
    ).toHaveLength(0);
  });

  it("is axe-clean", async () => {
    const { view } = renderConsole(fakeWithAgents(), "/console/agents");
    await screen.findByRole("table", { name: "Agents" });
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
