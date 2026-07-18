/**
 * API-keys feature tests (WP-C3.4; console-spec §9.7, journey W9). The API
 * client is a collaborator (fake at the `<ApiClientProvider>` seam); the wire
 * behavior is contract-tested in `src/api/__tests__/`.
 *
 * The DP-8 invariants proven here: scopes opt UP from `["read"]` (write and
 * admin start unchecked), and the raw key exists in the DOM only between
 * issuance and the copy-and-confirm Done — never after (DOM-absence proof).
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { FakeConsoleApi } from "../../test/fake-console-api.js";
import { renderConsole } from "../../test/render-console.js";
import { axe } from "../../ui/test-utils.js";

/** The obviously-fake raw key the fake's issue response carries. */
const FAKE_RAW_KEY = "pmb_live_TESTISSUEDKEYNOTASECRET";

beforeEach(() => {
  window.localStorage.clear();
});

function fakeWithKeys(scopes: string[] = ["admin"]): FakeConsoleApi {
  const api = FakeConsoleApi.signedIn(scopes);
  api.addApiKey({ id: "apikey_01READER", name: "dashboards", scopes: ["read"] });
  api.addApiKey({
    id: "apikey_01BROAD",
    name: "org-admin",
    scopes: ["admin"],
  });
  api.addApiKey({
    id: "apikey_01WORKER",
    name: "worker-key",
    scopes: ["self_hosted_worker:env_01HOSTAAA"],
  });
  return api;
}

describe("API keys list (§9.7, W9)", () => {
  it("renders scope chips per key — the over-broad admin key and the worker binding are visible at a glance", async () => {
    renderConsole(fakeWithKeys(), "/console/settings/api-keys");
    const table = await screen.findByRole("table", { name: "API keys" });

    const [reader, broad, worker] = within(table).getAllByRole("row").slice(1);
    expect(within(reader!).getByText("dashboards")).toBeInTheDocument();
    expect(within(reader!).getByText("read")).toBeInTheDocument();
    expect(within(broad!).getByText("admin")).toBeInTheDocument();
    // Worker keys render their environment binding, not the raw scope marker.
    expect(
      within(worker!).getByText("worker · env_01HOSTAAA"),
    ).toBeInTheDocument();
    // No raw key material anywhere in a list read (records never carry it).
    expect(document.body.textContent).not.toContain("pmb_live_");
  });

  it("teaching empty state carries the API command and the create flow (DP-5)", async () => {
    renderConsole(FakeConsoleApi.signedIn(["admin"]), "/console/settings/api-keys");
    expect(await screen.findByText("No API keys yet")).toBeInTheDocument();
    // A WORKING command: the backend hard-requires an admin bearer, the
    // Idempotency-Key, and a JSON content type for POST /v1/api-keys.
    const taught = screen.getByText(/curl -X POST .*\/v1\/api-keys/);
    expect(taught.textContent).toContain("Authorization: Bearer");
    expect(taught.textContent).toContain("Idempotency-Key:");
    expect(taught.textContent).toContain("Content-Type: application/json");
    expect(
      screen.getAllByRole("button", { name: "Issue key" }).length,
    ).toBeGreaterThan(0);
  });

  it("non-admin keys see issue/revoke disabled with the reason (§6.1)", async () => {
    renderConsole(fakeWithKeys(["read"]), "/console/settings/api-keys");
    await screen.findByRole("table", { name: "API keys" });

    const issue = screen.getByRole("button", { name: "Issue key" });
    expect(issue).toBeDisabled();
    expect(issue).toHaveAccessibleDescription("requires the admin scope");
    for (const revoke of screen.getAllByRole("button", { name: "Revoke" })) {
      expect(revoke).toBeDisabled();
    }
  });

  it("is axe-clean", async () => {
    const { view } = renderConsole(fakeWithKeys(), "/console/settings/api-keys");
    await screen.findByRole("table", { name: "API keys" });
    expect(await axe(view.container)).toHaveNoViolations();
  });
});

describe("issue flow (§9.7: opt-up scopes, show-once secret)", () => {
  it("scopes opt UP from [read]: read pre-checked, write/admin unchecked", async () => {
    const user = userEvent.setup();
    renderConsole(fakeWithKeys(), "/console/settings/api-keys");
    await screen.findByRole("table", { name: "API keys" });

    await user.click(screen.getByRole("button", { name: "Issue key" }));
    const dialog = await screen.findByRole("dialog", { name: "Issue API key" });
    const read = within(dialog).getByRole("checkbox", { name: "read" });
    expect(read).toBeChecked();
    // read is the FLOOR: backend scope matching is exact (write does not
    // imply read), so the console never lets it be unchecked.
    expect(read).toBeDisabled();
    expect(read).toHaveAccessibleDescription(/the floor/);
    expect(
      within(dialog).getByRole("checkbox", { name: "write" }),
    ).not.toBeChecked();
    expect(
      within(dialog).getByRole("checkbox", { name: "admin" }),
    ).not.toBeChecked();
    // The write hint must NOT claim write implies read (it does not).
    expect(dialog.textContent).not.toContain("plus all of read");
  });

  it("issues with the opted-up scopes, reveals the key exactly once, and forgets it after copy-and-confirm (DP-8 DOM-absence)", async () => {
    const user = userEvent.setup();
    const api = fakeWithKeys();
    renderConsole(api, "/console/settings/api-keys");
    await screen.findByRole("table", { name: "API keys" });

    await user.click(screen.getByRole("button", { name: "Issue key" }));
    const dialog = await screen.findByRole("dialog", { name: "Issue API key" });
    await user.type(within(dialog).getByLabelText("Name"), "ci-writer");
    await user.click(within(dialog).getByRole("checkbox", { name: "write" }));
    await user.click(within(dialog).getByRole("button", { name: "Issue key" }));

    // The raw key renders once, in the reveal.
    expect(await screen.findByText(FAKE_RAW_KEY)).toBeInTheDocument();
    expect(api.calls).toContainEqual({
      method: "POST",
      path: "/v1/api-keys",
      body: { name: "ci-writer", scopes: ["read", "write"] },
    });

    // Copy-and-confirm: Done is gated on the acknowledgement.
    const done = screen.getByRole("button", { name: "Done" });
    expect(done).toBeDisabled();
    await user.click(
      screen.getByRole("checkbox", { name: /I have stored this API key/ }),
    );
    await user.click(done);

    // DOM-absence proof: after confirm the secret exists nowhere — the
    // refreshed list row carries the record only.
    const table = await screen.findByRole("table", { name: "API keys" });
    expect(await within(table).findByText("ci-writer")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(FAKE_RAW_KEY);
  });

  it("requires a name; read is the un-uncheckable floor (§9.7)", async () => {
    const user = userEvent.setup();
    const api = fakeWithKeys();
    renderConsole(api, "/console/settings/api-keys");
    await screen.findByRole("table", { name: "API keys" });

    await user.click(screen.getByRole("button", { name: "Issue key" }));
    const dialog = await screen.findByRole("dialog", { name: "Issue API key" });
    const submit = within(dialog).getByRole("button", { name: "Issue key" });
    expect(submit).toBeDisabled();
    expect(submit).toHaveAccessibleDescription("name the key to issue it");

    // read cannot be unchecked — a click on the locked box changes nothing,
    // so every issued key includes the browse floor.
    await user.type(within(dialog).getByLabelText("Name"), "floor-check");
    await user.click(within(dialog).getByRole("checkbox", { name: "read" }));
    expect(within(dialog).getByRole("checkbox", { name: "read" })).toBeChecked();
    await user.click(submit);
    expect(api.calls).toContainEqual({
      method: "POST",
      path: "/v1/api-keys",
      body: { name: "floor-check", scopes: ["read"] },
    });
  });
});

describe("revoke (§9.7, DP-7)", () => {
  it("typed confirmation names the real consequences — console sessions die with the key", async () => {
    const user = userEvent.setup();
    const api = fakeWithKeys();
    renderConsole(api, "/console/settings/api-keys");
    const table = await screen.findByRole("table", { name: "API keys" });

    const row = within(table).getAllByRole("row")[1]!;
    await user.click(within(row).getByRole("button", { name: "Revoke" }));

    const dialog = await screen.findByRole("dialog", { name: "Revoke API key" });
    expect(dialog.textContent).toContain(
      "any console sessions signed in with this key are signed out",
    );
    expect(dialog.textContent).toContain("Revocation is permanent");

    // The destructive button enables only on an exact retype (DP-7).
    const confirm = within(dialog).getByRole("button", { name: "Revoke key" });
    expect(confirm).toBeDisabled();
    await user.type(
      within(dialog).getByLabelText('Type "dashboards" to confirm'),
      "dashboards",
    );
    await user.click(confirm);

    expect(api.calls).toContainEqual({
      method: "DELETE",
      path: "/v1/api-keys/apikey_01READER",
    });
    // The refreshed list shows the terminal state instead of a revoke action.
    const refreshed = await screen.findByRole("table", { name: "API keys" });
    const revokedRow = within(refreshed).getAllByRole("row")[1]!;
    expect(await within(revokedRow).findByText("revoked")).toBeInTheDocument();
    expect(
      within(revokedRow).queryByRole("button", { name: "Revoke" }),
    ).not.toBeInTheDocument();
  });
});
