/**
 * W1 sign-in → shell → sign-out flow (WP-C1.6; console-spec §4 client side),
 * including the §13 item 4.1 client half: after a full simulated sign-in, no
 * key material exists in any JS-readable storage. The API client is a
 * collaborator (fake at the `<ApiClientProvider>` seam); the real client's
 * wire behavior is contract-tested in src/api/__tests__/.
 */
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { FakeConsoleApi } from "../test/fake-console-api.js";
import { renderConsole } from "../test/render-console.js";
import "../ui/test-utils.js"; // afterEach(cleanup)

const API_KEY = "pmb_live_supersecretkeymaterial";

/** §4.1: nothing key-like in localStorage/sessionStorage — inspect BOTH fully. */
function expectNoKeyMaterialInStorage() {
  for (const storage of [window.localStorage, window.sessionStorage]) {
    for (let i = 0; i < storage.length; i += 1) {
      const name = storage.key(i);
      expect(name).not.toBeNull();
      expect(name).not.toContain(API_KEY);
      expect(storage.getItem(name ?? "")).not.toContain(API_KEY);
    }
  }
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("W1 — sign in", () => {
  it("boots signed-out to the sign-in screen (GET /console/session → 401)", async () => {
    const api = new FakeConsoleApi();
    renderConsole(api);
    expect(await screen.findByLabelText("API key")).toBeInTheDocument();
    expect(api.calls).toContainEqual({
      method: "GET",
      path: "/console/session",
    });
  });

  it("exchanges the key for a session, lands in the shell, leaves no key in storage, and signs out", async () => {
    const user = userEvent.setup();
    const api = new FakeConsoleApi().acceptKey(API_KEY, ["read", "write"]);
    renderConsole(api);

    // Sign in.
    await user.type(await screen.findByLabelText("API key"), API_KEY);
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    // The shell shows the tenant name and the key's scopes (W1 step 2).
    expect(await screen.findByText("Acme Corp")).toBeInTheDocument();
    expect(screen.getByText("key scopes: read, write")).toBeInTheDocument();

    // §13 item 4.1 (client half): no key material in JS-readable storage.
    expectNoKeyMaterialInStorage();

    // Sign out → server-side record destroyed, back at sign-in.
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByLabelText("API key")).toBeInTheDocument();
    expect(api.calls).toContainEqual({
      method: "DELETE",
      path: "/console/session",
    });
    expect(api.signedIn).toBeNull();
    expectNoKeyMaterialInStorage();
  });

  it("boots straight into the shell when a session cookie is already live", async () => {
    renderConsole(FakeConsoleApi.signedIn(["read"]));
    expect(await screen.findByText("Acme Corp")).toBeInTheDocument();
    // Never asked for a key.
    expect(screen.queryByLabelText("API key")).not.toBeInTheDocument();
  });
});
