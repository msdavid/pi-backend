/**
 * Phase-1 gate — console-spec §13 item §4.1 (client half): after a full
 * sign-in through the real app tree, no API-key material exists in ANY
 * JS-readable storage — `localStorage`, `sessionStorage`, or JS-visible
 * cookies (`document.cookie`). Gate-level extension of
 * `src/app/auth-flow.test.tsx` (which covers the flow itself); the server
 * half — the session cookie being `HttpOnly` — is asserted in
 * `console-headers.gate.test.ts` against the real backend.
 *
 * The API client is a collaborator here (fake injected at the
 * `<ApiClientProvider>` seam); what this gate inspects is the browser-side
 * storage the REAL app tree touches during sign-in/sign-out.
 */
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { FakeConsoleApi } from "../../src/test/fake-console-api.js";
import { renderConsole } from "../../src/test/render-console.js";
import "../../src/ui/test-utils.js"; // afterEach(cleanup)

/** Distinctive so a substring scan can't false-negative. */
const API_KEY = "pmb_live_gate41supersecretkeymaterial";

/** §4.1: scan EVERY JS-readable storage surface for the key. */
function expectNoKeyMaterialAnywhere() {
  for (const storage of [window.localStorage, window.sessionStorage]) {
    for (let i = 0; i < storage.length; i += 1) {
      const name = storage.key(i);
      expect(name).not.toBeNull();
      expect(name).not.toContain(API_KEY);
      expect(storage.getItem(name ?? "")).not.toContain(API_KEY);
    }
  }
  // JS-visible cookies: the real session cookie is HttpOnly (server half);
  // nothing client-side may write key material into a readable one.
  expect(document.cookie).not.toContain(API_KEY);
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("§4.1 — no key material in JS-readable storage", () => {
  it("after sign-in and after sign-out", async () => {
    const user = userEvent.setup();
    const api = new FakeConsoleApi().acceptKey(API_KEY, ["read", "write"]);
    renderConsole(api);

    await user.type(await screen.findByLabelText("API key"), API_KEY);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Acme Corp")).toBeInTheDocument();

    expectNoKeyMaterialAnywhere();

    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByLabelText("API key")).toBeInTheDocument();
    expectNoKeyMaterialAnywhere();
  });

  it("a rejected key is not persisted either", async () => {
    const user = userEvent.setup();
    renderConsole(new FakeConsoleApi()); // no accepted keys
    await user.type(await screen.findByLabelText("API key"), API_KEY);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    // DP-9 error rendering appears; storage stays clean.
    expect(
      await screen.findByText(/That key was not accepted/),
    ).toBeInTheDocument();
    expectNoKeyMaterialAnywhere();
  });
});
