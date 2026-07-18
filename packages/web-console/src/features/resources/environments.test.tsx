/**
 * Environments list + create feature tests (WP-C3.2; console-spec §9.2).
 * The API client is a collaborator (fake at the `<ApiClientProvider>` seam):
 * list columns, server-side `?status=` filtering, the DP-5 teaching empty
 * state, write-gated create (disabled WITH its reason under `read`, §6.1),
 * and the create dialog's network-policy explanations (DP-6).
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { FakeConsoleApi } from "../../test/fake-console-api.js";
import { renderConsole } from "../../test/render-console.js";
import { axe } from "../../ui/test-utils.js";

const LIST = "/console/resources/environments";

beforeEach(() => {
  window.localStorage.clear();
});

function fakeWithEnvironments(scopes = ["admin"]): FakeConsoleApi {
  const api = FakeConsoleApi.signedIn(scopes);
  api.addEnvironment({
    id: "env_01CLOUD",
    name: "python-env",
    type: "cloud",
    image: "ubuntu:22.04",
  });
  api.addEnvironment({
    id: "env_01WORKERS",
    name: "gpu-workers",
    type: "self_hosted",
    status: "archived",
  });
  return api;
}

describe("environments list (§9.2)", () => {
  it("renders name, id, type, status, and updated columns", async () => {
    renderConsole(fakeWithEnvironments(), LIST);
    const table = await screen.findByRole("table", { name: "Environments" });

    const headers = within(table)
      .getAllByRole("columnheader")
      .map((th) => th.textContent);
    expect(headers).toEqual(["Name", "ID", "Type", "Status", "Updated"]);

    const row = within(table).getAllByRole("row")[1]!;
    expect(within(row).getByText("python-env")).toBeInTheDocument();
    expect(within(row).getByTitle("env_01CLOUD")).toBeInTheDocument();
    expect(within(row).getByText("cloud")).toBeInTheDocument();
    expect(within(row).getByText("active")).toBeInTheDocument();
  });

  it("row activation navigates to the environment detail route", async () => {
    const user = userEvent.setup();
    const { router } = renderConsole(fakeWithEnvironments(), LIST);
    const table = await screen.findByRole("table", { name: "Environments" });
    await user.click(within(table).getByText("python-env"));
    expect(router.state.location.pathname).toBe(
      "/resources/environments/env_01CLOUD",
    );
  });

  it("status filter narrows server-side via ?status= (not client-side)", async () => {
    const user = userEvent.setup();
    const api = fakeWithEnvironments();
    renderConsole(api, LIST);
    await screen.findByRole("table", { name: "Environments" });

    await user.selectOptions(
      screen.getByLabelText("Status"),
      "archived",
    );
    const table = await screen.findByRole("table", { name: "Environments" });
    expect(await within(table).findByText("gpu-workers")).toBeInTheDocument();
    expect(within(table).queryByText("python-env")).not.toBeInTheDocument();
    expect(
      api.calls.some(
        (c) => c.method === "GET" && c.path.includes("status=archived"),
      ),
    ).toBe(true);
  });

  it("teaching empty state carries the API command and create flow (DP-5)", async () => {
    renderConsole(FakeConsoleApi.signedIn(["admin"]), LIST);
    expect(await screen.findByText("No environments yet")).toBeInTheDocument();
    // A WORKING command (DP-5): bearer + Idempotency-Key + JSON content type.
    const taught = screen.getByText(/curl -X POST .*\/v1\/environments/);
    expect(taught.textContent).toContain("Authorization: Bearer");
    expect(taught.textContent).toContain("Idempotency-Key:");
    expect(taught.textContent).toContain("Content-Type: application/json");
    // Admin sees the create flow inside the empty state too.
    expect(
      screen.getAllByRole("button", { name: "Create environment" }).length,
    ).toBeGreaterThan(1);
  });

  it("read scope: create is disabled WITH its reason (§6.1)", async () => {
    renderConsole(fakeWithEnvironments(["read"]), LIST);
    await screen.findByRole("table", { name: "Environments" });
    const create = screen.getByRole("button", { name: "Create environment" });
    expect(create).toBeDisabled();
    // §6.2: the reason names the scope the backend ACTUALLY requires.
    expect(create).toHaveAccessibleDescription("requires the write scope");
  });

  it("write scope enables create (§6.2 — resource management is a write surface)", async () => {
    renderConsole(fakeWithEnvironments(["read", "write"]), LIST);
    await screen.findByRole("table", { name: "Environments" });
    expect(
      screen.getByRole("button", { name: "Create environment" }),
    ).toBeEnabled();
  });

  it("is axe-clean", async () => {
    const { view } = renderConsole(fakeWithEnvironments(), LIST);
    await screen.findByRole("table", { name: "Environments" });
    expect(await axe(view.container)).toHaveNoViolations();
  });
});

describe("environment create (§9.2, write-gated)", () => {
  it("creates a cloud environment and navigates to its detail", async () => {
    const user = userEvent.setup();
    const api = fakeWithEnvironments();
    const { router } = renderConsole(api, LIST);
    await screen.findByRole("table", { name: "Environments" });

    await user.click(
      screen.getByRole("button", { name: "Create environment" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Create environment",
    });
    await user.type(within(dialog).getByLabelText("Name"), "node-env");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(router.state.location.pathname).toMatch(
        /^\/resources\/environments\/env_/,
      ),
    );
    const created = api.calls.find(
      (c) => c.method === "POST" && c.path === "/v1/environments",
    );
    expect(created?.body).toMatchObject({ name: "node-env", type: "cloud" });
  });

  it("limited network policy explains itself (DP-6) and sends allowedHosts", async () => {
    const user = userEvent.setup();
    const api = fakeWithEnvironments();
    renderConsole(api, LIST);
    await screen.findByRole("table", { name: "Environments" });

    await user.click(
      screen.getByRole("button", { name: "Create environment" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Create environment",
    });
    await user.type(within(dialog).getByLabelText("Name"), "locked-env");
    await user.selectOptions(
      within(dialog).getByLabelText("Network policy"),
      "limited",
    );
    // The one-line DP-6 explanation swaps with the selection.
    expect(
      within(dialog).getByText(/Default-deny egress/),
    ).toBeInTheDocument();
    await user.type(
      within(dialog).getByLabelText("Allowed hosts"),
      "api.github.com, pypi.org",
    );
    await user.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(
        api.calls.some(
          (c) => c.method === "POST" && c.path === "/v1/environments",
        ),
      ).toBe(true),
    );
    const created = api.calls.find(
      (c) => c.method === "POST" && c.path === "/v1/environments",
    );
    expect(created?.body).toMatchObject({
      name: "locked-env",
      networking: {
        mode: "limited",
        allowedHosts: ["api.github.com", "pypi.org"],
      },
    });
  });

  it("self_hosted type swaps in the worker-model explainer (DP-6)", async () => {
    const user = userEvent.setup();
    renderConsole(fakeWithEnvironments(), LIST);
    await screen.findByRole("table", { name: "Environments" });

    await user.click(
      screen.getByRole("button", { name: "Create environment" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Create environment",
    });
    await user.selectOptions(
      within(dialog).getByLabelText("Type"),
      "self_hosted",
    );
    expect(
      within(dialog).getByText(/workers on your own machines claim and run/),
    ).toBeInTheDocument();
    // Cloud-only fields are gone.
    expect(
      within(dialog).queryByLabelText("Network policy"),
    ).not.toBeInTheDocument();
  });
});
