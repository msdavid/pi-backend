/**
 * Environment detail feature tests (WP-C3.2; console-spec §9.2): the cloud
 * configuration surface with its DP-6 network-policy one-liners, edit
 * (PATCH, "not versioned" microcopy), and the DP-7 typed confirmations for
 * archive (terminal) and hard delete.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { FakeConsoleApi } from "../../test/fake-console-api.js";
import { renderConsole } from "../../test/render-console.js";
import { axe } from "../../ui/test-utils.js";

const DETAIL = "/console/resources/environments/env_01CLOUD";

beforeEach(() => {
  window.localStorage.clear();
});

function fakeWithCloudEnv(scopes = ["admin"]): FakeConsoleApi {
  const api = FakeConsoleApi.signedIn(scopes);
  api.addEnvironment({
    id: "env_01CLOUD",
    name: "python-env",
    type: "cloud",
    image: "ubuntu:22.04",
    resources: { cpus: 2, memoryMiB: 2048 },
    networking: { mode: "limited", allowedHosts: ["api.github.com"] },
  });
  return api;
}

describe("environment detail — cloud (§9.2)", () => {
  it("leads with the facts and shows image, resources, and network policy", async () => {
    renderConsole(fakeWithCloudEnv(), DETAIL);
    expect(
      await screen.findByRole("heading", { name: "python-env" }),
    ).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("cloud")).toBeInTheDocument();

    const config = screen.getByRole("region", {
      name: "Sandbox configuration",
    });
    expect(within(config).getByText("ubuntu:22.04")).toBeInTheDocument();
    expect(
      within(config).getByText("2 CPUs · 2048 MiB memory"),
    ).toBeInTheDocument();
    // DP-6: the `limited` one-liner plus the explicit allow list.
    expect(within(config).getByText("limited")).toBeInTheDocument();
    expect(
      within(config).getByText(/Default-deny egress/),
    ).toBeInTheDocument();
    expect(within(config).getByText("api.github.com")).toBeInTheDocument();
  });

  it("explains `unrestricted` in one line (DP-6)", async () => {
    const api = FakeConsoleApi.signedIn(["admin"]);
    api.addEnvironment({
      id: "env_01CLOUD",
      name: "open-env",
      type: "cloud",
      networking: { mode: "unrestricted" },
    });
    renderConsole(api, DETAIL);
    await screen.findByRole("heading", { name: "open-env" });
    expect(
      screen.getByText(/host, local network, and cloud metadata stay unreachable/),
    ).toBeInTheDocument();
  });

  it("read scope: lifecycle actions are disabled WITH the reason (§6.1)", async () => {
    renderConsole(fakeWithCloudEnv(["read"]), DETAIL);
    await screen.findByRole("heading", { name: "python-env" });
    for (const name of ["Edit", "Archive", "Delete"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toBeDisabled();
      // §6.2: the reason names the scope the backend ACTUALLY requires.
      expect(button).toHaveAccessibleDescription("requires the write scope");
    }
  });

  it("write scope: lifecycle actions are enabled (§6.2 — write, not admin)", async () => {
    renderConsole(fakeWithCloudEnv(["read", "write"]), DETAIL);
    await screen.findByRole("heading", { name: "python-env" });
    for (const name of ["Edit", "Archive", "Delete"]) {
      expect(screen.getByRole("button", { name })).toBeEnabled();
    }
  });

  it("is axe-clean", async () => {
    const { view } = renderConsole(fakeWithCloudEnv(), DETAIL);
    await screen.findByRole("heading", { name: "python-env" });
    expect(await axe(view.container)).toHaveNoViolations();
  });
});

describe("environment lifecycle (§9.2, DP-7)", () => {
  it("edit PATCHes the environment and says PATCH is not versioned", async () => {
    const user = userEvent.setup();
    const api = fakeWithCloudEnv();
    renderConsole(api, DETAIL);
    await screen.findByRole("heading", { name: "python-env" });

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Edit environment",
    });
    // DP-6: what a PATCH means here.
    expect(
      within(dialog).getByText(/not versioned — sessions created after/),
    ).toBeInTheDocument();

    const name = within(dialog).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "python-env-v2");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(
      await screen.findByRole("heading", { name: "python-env-v2" }),
    ).toBeInTheDocument();
    const patch = api.calls.find(
      (c) => c.method === "PATCH" && c.path === "/v1/environments/env_01CLOUD",
    );
    expect(patch?.body).toMatchObject({ name: "python-env-v2" });
  });

  it("archive requires retyping the name and names the terminal consequence", async () => {
    const user = userEvent.setup();
    const api = fakeWithCloudEnv();
    renderConsole(api, DETAIL);
    await screen.findByRole("heading", { name: "python-env" });

    await user.click(screen.getByRole("button", { name: "Archive" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Archive environment",
    });
    expect(
      within(dialog).getByText(/terminal — there is no unarchive/),
    ).toBeInTheDocument();

    // The destructive button stays locked until the name matches (DP-7).
    const confirm = within(dialog).getByRole("button", { name: "Archive" });
    expect(confirm).toBeDisabled();
    await user.type(
      within(dialog).getByLabelText('Type "python-env" to confirm'),
      "python-env",
    );
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    expect(
      api.calls.some(
        (c) =>
          c.method === "POST" &&
          c.path === "/v1/environments/env_01CLOUD/archive",
      ),
    ).toBe(true);
    expect(await screen.findByText("archived")).toBeInTheDocument();
    // Archival is terminal: the action is now disabled with the reason.
    const archive = screen.getByRole("button", { name: "Archive" });
    expect(archive).toBeDisabled();
    expect(archive).toHaveAccessibleDescription(
      "already archived — archival is terminal",
    );
  });

  it("delete confirms, hard-deletes, and returns to the list", async () => {
    const user = userEvent.setup();
    const api = fakeWithCloudEnv();
    const { router } = renderConsole(api, DETAIL);
    await screen.findByRole("heading", { name: "python-env" });

    await user.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Delete environment",
    });
    expect(
      within(dialog).getByText(/cannot be undone/),
    ).toBeInTheDocument();
    await user.type(
      within(dialog).getByLabelText('Type "python-env" to confirm'),
      "python-env",
    );
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/resources/environments"),
    );
    expect(
      api.calls.some(
        (c) =>
          c.method === "DELETE" && c.path === "/v1/environments/env_01CLOUD",
      ),
    ).toBe(true);
  });
});
