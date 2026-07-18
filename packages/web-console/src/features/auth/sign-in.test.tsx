/**
 * Sign-in screen (WP-C1.6; console-spec §5 copy variants, §4.2, DP-9).
 * The API client is a collaborator — a fake is injected at the
 * `<ApiClientProvider>` seam (see src/test/fake-console-api.ts).
 */
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterContextProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ApiClientProvider } from "../../api/provider.js";
import { createConsoleRouter } from "../../app/router.js";
import { createQueryClient } from "../../app/query.js";
import { FakeConsoleApi } from "../../test/fake-console-api.js";
import { axe } from "../../ui/test-utils.js";
import { SignInPage } from "./sign-in.js";

function renderSignIn(api: FakeConsoleApi) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ApiClientProvider api={api}>
        {/* Router context (no route rendering): the page links to /signup
            in saas mode (WP-C3.7). */}
        <RouterContextProvider router={createConsoleRouter()}>
          <SignInPage />
        </RouterContextProvider>
      </ApiClientProvider>
    </QueryClientProvider>,
  );
}

function fakeFor(mode: "solo" | "team" | "saas") {
  const api = new FakeConsoleApi();
  api.config = { mode, onboardingEnabled: mode === "saas" };
  return api;
}

describe("SignInPage mode copy (console-spec §5)", () => {
  it("solo: explains how to obtain the first key", async () => {
    renderSignIn(fakeFor("solo"));
    expect(
      await screen.findByText("Paste an API key for your backend to start browsing."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/POST \/v1\/onboarding\/signup/),
    ).toBeInTheDocument();
  });

  it("team: addresses the key your admin issued, least privilege", async () => {
    renderSignIn(fakeFor("team"));
    expect(
      await screen.findByText("Paste the API key your admin issued you."),
    ).toBeInTheDocument();
    expect(screen.getByText(/read-scoped key is enough/)).toBeInTheDocument();
  });

  it("saas: plain sign-in framing (signup page is phase 3)", async () => {
    renderSignIn(fakeFor("saas"));
    expect(
      await screen.findByText("Sign in with an API key for your tenant."),
    ).toBeInTheDocument();
  });
});

describe("SignInPage key exchange (console-spec §4.2)", () => {
  it("posts the pasted key and clears the field on success", async () => {
    const user = userEvent.setup();
    const api = fakeFor("solo").acceptKey("pmb_live_valid", ["read"]);
    renderSignIn(api);

    const input = await screen.findByLabelText("API key");
    await user.type(input, "pmb_live_valid");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(api.calls).toContainEqual({
      method: "POST",
      path: "/console/session",
      body: { apiKey: "pmb_live_valid" },
    });
    // The key variable is dropped once exchanged for the cookie (§4.1).
    expect(await screen.findByLabelText("API key")).toHaveValue("");
  });

  it("renders a rejected key per DP-9: message + code + request id", async () => {
    const user = userEvent.setup();
    renderSignIn(fakeFor("solo"));

    await user.type(await screen.findByLabelText("API key"), "pmb_live_nope");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    const error = await screen.findByText(/That key was not accepted/);
    expect(error).toHaveTextContent("unauthorized · req_01TESTREQUEST");
    // DP-9: the rendered code/requestId link to the docs that explain them.
    expect(screen.getByRole("link", { name: "docs" })).toHaveAttribute(
      "href",
      "https://github.com/msdavid/pi-backend/blob/main/docs/api-reference.md#error-envelope",
    );
    // The field stays populated so the user can inspect/fix what they pasted.
    expect(screen.getByLabelText("API key")).toHaveValue("pmb_live_nope");
  });

  it("disables submit while the field is empty", async () => {
    renderSignIn(fakeFor("solo"));
    expect(
      await screen.findByRole("button", { name: "Sign in" }),
    ).toBeDisabled();
  });
});

describe("accessibility", () => {
  it("axe-clean", async () => {
    const { container } = renderSignIn(fakeFor("solo"));
    await screen.findByLabelText("API key");
    expect(await axe(container)).toHaveNoViolations();
  });
});
