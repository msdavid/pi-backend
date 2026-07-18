/**
 * Vaults & credentials feature tests (WP-C3.3; console-spec §9.3, journey
 * W11). The API client is a collaborator (fake at the `<ApiClientProvider>`
 * seam). The C§13 acceptance sits here: fixtures only ever hold
 * obviously-fake placeholders, and the "write-only secret" tests PROVE the
 * submitted value is absent from the entire document after submit.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { FakeConsoleApi } from "../../test/fake-console-api.js";
import { renderConsole } from "../../test/render-console.js";
import { axe } from "../../ui/test-utils.js";

beforeEach(() => {
  window.localStorage.clear();
});

/** Obviously fake — never a real-looking provider credential (C§13). */
const FAKE_SECRET = "test-placeholder-not-a-secret";

function fakeWithVault(scopes: string[] = ["admin"]): FakeConsoleApi {
  const api = FakeConsoleApi.signedIn(scopes);
  api.addVault({ id: "vault_01TEAM", name: "team-secrets" });
  api.addCredential("vault_01TEAM", {
    key: "anthropic",
    category: "model_provider_key",
  });
  api.addCredential("vault_01TEAM", {
    key: "GIT_TOKEN",
    category: "environment_variable",
  });
  return api;
}

const LIST = "/console/resources/vaults";
const DETAIL = "/console/resources/vaults/vault_01TEAM";

describe("vaults list (§9.3)", () => {
  it("renders name, id, status, and updated columns", async () => {
    renderConsole(fakeWithVault(), LIST);
    const table = await screen.findByRole("table", { name: "Vaults" });

    const headers = within(table)
      .getAllByRole("columnheader")
      .map((th) => th.textContent);
    expect(headers).toEqual(["Name", "ID", "Status", "Updated"]);

    const row = within(table).getAllByRole("row")[1]!;
    expect(within(row).getByText("team-secrets")).toBeInTheDocument();
    expect(within(row).getByTitle("vault_01TEAM")).toBeInTheDocument();
    expect(within(row).getByText("active")).toBeInTheDocument();
  });

  it("row activation navigates to the vault detail route", async () => {
    const user = userEvent.setup();
    const { router } = renderConsole(fakeWithVault(), LIST);
    const table = await screen.findByRole("table", { name: "Vaults" });
    await user.click(within(table).getByText("team-secrets"));
    expect(router.state.location.pathname).toBe(
      "/resources/vaults/vault_01TEAM",
    );
  });

  it("teaching empty state carries the CLI command (DP-5)", async () => {
    renderConsole(FakeConsoleApi.signedIn(["admin"]), LIST);
    expect(await screen.findByText("No vaults yet")).toBeInTheDocument();
    expect(screen.getByText("/remote:vault create")).toBeInTheDocument();
  });

  it("creates a vault and lands on its detail page", async () => {
    const user = userEvent.setup();
    const api = FakeConsoleApi.signedIn(["admin"]);
    const { router } = renderConsole(api, LIST);

    // Header + teaching empty state each offer the create flow (DP-5).
    const newButtons = await screen.findAllByRole("button", {
      name: "New vault",
    });
    await user.click(newButtons[0]!);
    await user.type(screen.getByLabelText("Name"), "prod-keys");
    await user.click(screen.getByRole("button", { name: "Create vault" }));

    await waitFor(() =>
      expect(router.state.location.pathname).toMatch(/^\/resources\/vaults\//),
    );
    expect(
      api.calls.some(
        (c) =>
          c.method === "POST" &&
          c.path === "/v1/vaults" &&
          (c.body as { name?: string }).name === "prod-keys",
      ),
    ).toBe(true);
  });

  it("read-only keys see New vault disabled with the reason (§6.1)", async () => {
    renderConsole(fakeWithVault(["read"]), LIST);
    const button = await screen.findByRole("button", { name: "New vault" });
    expect(button).toBeDisabled();
    // §6.2: the reason names the scope the backend ACTUALLY requires.
    expect(button).toHaveAccessibleDescription("requires the write scope");
  });

  it("write scope enables New vault (§6.2 — resource management is a write surface)", async () => {
    renderConsole(fakeWithVault(["read", "write"]), LIST);
    expect(
      await screen.findByRole("button", { name: "New vault" }),
    ).toBeEnabled();
  });

  it("is axe-clean", async () => {
    const { view } = renderConsole(fakeWithVault(), LIST);
    await screen.findByRole("table", { name: "Vaults" });
    expect(await axe(view.container)).toHaveNoViolations();
  });
});

describe("vault detail (§9.3, W11)", () => {
  it("leads with the facts and groups credentials by category", async () => {
    renderConsole(fakeWithVault(), DETAIL);
    expect(
      await screen.findByRole("heading", { name: "team-secrets" }),
    ).toBeInTheDocument();

    const providerKeys = await screen.findByRole("region", {
      name: "Model provider keys",
    });
    expect(within(providerKeys).getByText("anthropic")).toBeInTheDocument();

    const envVars = screen.getByRole("region", {
      name: "Environment variables",
    });
    expect(within(envVars).getByText("GIT_TOKEN")).toBeInTheDocument();

    // Categories without records still teach what they are (DP-6).
    expect(
      within(
        screen.getByRole("region", { name: "Static bearer tokens" }),
      ).getByText("No static bearer tokens yet."),
    ).toBeInTheDocument();
  });

  it("explains fail-closed and ~60 s rotation propagation (DP-6)", async () => {
    renderConsole(fakeWithVault(), DETAIL);
    await screen.findByRole("heading", { name: "team-secrets" });
    expect(
      screen.getByText(/sessions fail before the\s+first model call/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/within ~60 s — no restarts/),
    ).toBeInTheDocument();
  });

  describe("add credential (DP-8: secret fields are write-only)", () => {
    it("takes the secret as a password field and never echoes it after submit", async () => {
      const user = userEvent.setup();
      const api = fakeWithVault();
      renderConsole(api, DETAIL);

      const section = await screen.findByRole("region", {
        name: "Static bearer tokens",
      });
      await user.click(within(section).getByRole("button", { name: "Add" }));

      const dialog = await screen.findByRole("dialog", {
        name: "Add: Static bearer tokens",
      });
      const secretInput = within(dialog).getByLabelText("Bearer token");
      // Write-only mechanics: masked input, no autofill memory.
      expect(secretInput).toHaveAttribute("type", "password");
      expect(secretInput).toHaveAttribute("autocomplete", "off");

      await user.type(
        within(dialog).getByLabelText("Server URL"),
        "https://mcp.example.com",
      );
      await user.type(secretInput, FAKE_SECRET);
      await user.click(
        within(dialog).getByRole("button", { name: "Add credential" }),
      );

      // The record lands in the section (the response carries no secret)…
      expect(
        await within(section).findByText("https://mcp.example.com"),
      ).toBeInTheDocument();
      // …the secret crossed the seam exactly once, in the create body…
      expect(
        api.calls.some(
          (c) =>
            c.method === "POST" &&
            c.path === "/v1/vaults/vault_01TEAM/credentials" &&
            (c.body as { token?: string }).token === FAKE_SECRET,
        ),
      ).toBe(true);
      // …and the C§13 acceptance: the submitted value appears NOWHERE in the
      // document — not as text, not retained in any input.
      expect(document.body.innerHTML).not.toContain(FAKE_SECRET);
      expect(screen.queryByDisplayValue(FAKE_SECRET)).not.toBeInTheDocument();
    });

    it("a cancelled dialog drops the typed secret from state", async () => {
      const user = userEvent.setup();
      renderConsole(fakeWithVault(), DETAIL);

      const section = await screen.findByRole("region", {
        name: "Model provider keys",
      });
      await user.click(within(section).getByRole("button", { name: "Add" }));
      const dialog = await screen.findByRole("dialog", {
        name: "Add: Model provider keys",
      });
      await user.type(within(dialog).getByLabelText("API key"), FAKE_SECRET);
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

      // Reopen: the field starts blank; the old value is gone from the DOM.
      await user.click(within(section).getByRole("button", { name: "Add" }));
      expect(
        within(
          await screen.findByRole("dialog", {
            name: "Add: Model provider keys",
          }),
        ).getByLabelText("API key"),
      ).toHaveValue("");
      expect(document.body.innerHTML).not.toContain(FAKE_SECRET);
    });
  });

  it("validates a credential live and renders the outcome (§12.5)", async () => {
    const user = userEvent.setup();
    const api = fakeWithVault();
    renderConsole(api, DETAIL);

    const section = await screen.findByRole("region", {
      name: "Model provider keys",
    });
    await user.click(
      within(section).getByRole("button", { name: "Validate" }),
    );
    expect(
      await within(section).findByText("valid — the grant is live"),
    ).toBeInTheDocument();
    expect(
      api.calls.some(
        (c) =>
          c.method === "POST" &&
          c.path === "/v1/vaults/vault_01TEAM/credentials/anthropic/validate",
      ),
    ).toBe(true);
  });

  it("an invalid grant prompts re-auth (DP-6)", async () => {
    const user = userEvent.setup();
    const api = fakeWithVault();
    api.credentialValidation = "invalid";
    renderConsole(api, DETAIL);

    const section = await screen.findByRole("region", {
      name: "Environment variables",
    });
    await user.click(
      within(section).getByRole("button", { name: "Validate" }),
    );
    expect(
      await within(section).findByText(
        "invalid — the grant is gone; add a fresh credential",
      ),
    ).toBeInTheDocument();
  });

  it("deletes a credential behind a typed confirmation naming the purge (DP-7)", async () => {
    const user = userEvent.setup();
    const api = fakeWithVault();
    renderConsole(api, DETAIL);

    const section = await screen.findByRole("region", {
      name: "Environment variables",
    });
    await user.click(within(section).getByRole("button", { name: "Delete" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Delete credential",
    });
    expect(dialog).toHaveTextContent("purges its secret immediately");

    // The destructive button stays disabled until the key is retyped.
    const confirm = within(dialog).getByRole("button", {
      name: "Delete credential",
    });
    expect(confirm).toBeDisabled();
    await user.type(
      within(dialog).getByLabelText('Type "GIT_TOKEN" to confirm'),
      "GIT_TOKEN",
    );
    await user.click(confirm);

    expect(
      api.calls.some(
        (c) =>
          c.method === "DELETE" &&
          c.path === "/v1/vaults/vault_01TEAM/credentials/GIT_TOKEN",
      ),
    ).toBe(true);
    // §12.7: the archived record remains, its actions replaced.
    expect(
      await within(section).findByText("archived — secret purged"),
    ).toBeInTheDocument();
  });

  it("archives the vault behind a typed confirmation naming the cascade (DP-7)", async () => {
    const user = userEvent.setup();
    const api = fakeWithVault();
    // Already-archived credentials have no secret left to purge — the DP-7
    // consequence must count ONLY the 2 active ones, not this record.
    api.addCredential("vault_01TEAM", {
      key: "rotated-out",
      category: "model_provider_key",
      status: "archived",
    });
    renderConsole(api, DETAIL);

    await user.click(
      await screen.findByRole("button", { name: "Archive vault" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Archive vault" });
    expect(dialog).toHaveTextContent(
      "archives its 2 active credentials and purges their secrets",
    );
    expect(dialog).toHaveTextContent("Archival is terminal.");

    await user.type(
      within(dialog).getByLabelText('Type "team-secrets" to confirm'),
      "team-secrets",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Archive vault" }),
    );

    expect(
      api.calls.some(
        (c) =>
          c.method === "POST" && c.path === "/v1/vaults/vault_01TEAM/archive",
      ),
    ).toBe(true);
    // The refetched vault renders the archived banner.
    expect(await screen.findByRole("alert")).toHaveTextContent("Archived.");
  });

  it("read-only keys see every mutating control disabled with the reason (§6.1)", async () => {
    renderConsole(fakeWithVault(["read"]), DETAIL);
    const section = await screen.findByRole("region", {
      name: "Model provider keys",
    });

    for (const name of ["Add", "Validate", "Delete"]) {
      const button = within(section).getByRole("button", { name });
      expect(button).toBeDisabled();
      // §6.2: the reason names the scope the backend ACTUALLY requires.
      expect(button).toHaveAccessibleDescription("requires the write scope");
    }
    const archive = screen.getByRole("button", { name: "Archive vault" });
    expect(archive).toBeDisabled();
    expect(archive).toHaveAccessibleDescription("requires the write scope");
  });

  it("write scope: every mutating control is enabled (§6.2 — write, not admin)", async () => {
    renderConsole(fakeWithVault(["read", "write"]), DETAIL);
    const section = await screen.findByRole("region", {
      name: "Model provider keys",
    });
    for (const name of ["Add", "Validate", "Delete"]) {
      expect(within(section).getByRole("button", { name })).toBeEnabled();
    }
    expect(screen.getByRole("button", { name: "Archive vault" })).toBeEnabled();
  });

  it("is axe-clean, including with the add dialog open", async () => {
    const user = userEvent.setup();
    const { view } = renderConsole(fakeWithVault(), DETAIL);
    const section = await screen.findByRole("region", {
      name: "Model provider keys",
    });
    expect(await axe(view.container)).toHaveNoViolations();

    await user.click(within(section).getByRole("button", { name: "Add" }));
    await screen.findByRole("dialog", { name: "Add: Model provider keys" });
    expect(await axe(document.body)).toHaveNoViolations();
  });
});
