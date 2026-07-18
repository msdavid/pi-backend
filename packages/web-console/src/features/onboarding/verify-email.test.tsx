/**
 * Trial email-verification landing (WP-C5.4; console-spec §11.1). Public route;
 * collaborator fake. Covers the token→verified happy path (unverified→verified
 * loop completes), the missing-token guard, and the expired-link (409) failure.
 */
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeConsoleApi, makeBillingState } from "../../test/fake-console-api.js";
import { renderConsole } from "../../test/render-console.js";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(cleanup);

/** A signed-in tenant with an unverified trial (the state the link resolves). */
function unverifiedApi(): FakeConsoleApi {
  const api = FakeConsoleApi.signedIn(["admin"]);
  api.config = { mode: "saas", onboardingEnabled: true };
  api.billingState = makeBillingState({
    lifecycle: "trial",
    verificationRequired: true,
    verified: false,
    balanceMicros: 0,
    balanceUsd: 0,
  });
  return api;
}

describe("verify-email landing (§11.1)", () => {
  it("verifies a valid token and reports the activated trial", async () => {
    const api = unverifiedApi();
    renderConsole(api, "/console/verify-email?token=tok_valid");

    await userEvent.click(
      await screen.findByRole("button", { name: /Verify my email/ }),
    );
    expect(
      await screen.findByText(/\$5 trial balance is now active/),
    ).toBeInTheDocument();
    // The activation flipped the billing state + appended the grant.
    expect(api.billingState?.verificationRequired).toBe(false);
    expect(api.ledgerEntries.some((e) => e.kind === "grant")).toBe(true);
  });

  it("guards a link missing its token", async () => {
    const api = unverifiedApi();
    renderConsole(api, "/console/verify-email");
    expect(
      await screen.findByText(/missing its verification token/),
    ).toBeInTheDocument();
    expect(
      api.calls.some((c) => c.path === "/v1/onboarding/verify-email"),
    ).toBe(false);
  });

  it("explains an expired link (409) with a resend path", async () => {
    const api = unverifiedApi();
    renderConsole(api, "/console/verify-email?token=tok_expired");
    await userEvent.click(
      await screen.findByRole("button", { name: /Verify my email/ }),
    );
    expect(await screen.findByText(/this link has expired/)).toBeInTheDocument();
  });
});
