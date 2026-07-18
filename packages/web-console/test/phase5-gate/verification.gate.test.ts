/**
 * Phase-5 gate — §11.1: unverified-trial surfacing + resend, and verification
 * as the gate before "start a first session" in saas.
 *
 *  - The unverified state is surfaced prominently (Home + Billing) with a
 *    resend action.
 *  - The first-run checklist blocks step 3 (start a session) until verified —
 *    an unverified trial is fail-soft suspended (reads work, no new work).
 *  - The verify-email landing activates the trial and reports the grant.
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { FakeConsoleApi, makeBillingState } from "../../src/test/fake-console-api.js";
import { renderConsole } from "../../src/test/render-console.js";
import "../../src/ui/test-utils.js"; // afterEach(cleanup)

const SAAS = { mode: "saas", onboardingEnabled: true } as const;

function unverified(): FakeConsoleApi {
  const api = FakeConsoleApi.signedIn(["admin"]);
  api.config = SAAS;
  api.billingState = makeBillingState({
    lifecycle: "trial",
    verificationRequired: true,
    verified: false,
    balanceMicros: 0,
    balanceUsd: 0,
  });
  return api;
}

describe("§11.1 — unverified trial surfaced with resend (Home)", () => {
  it("Home shows the verify notice; resend calls the endpoint", async () => {
    const api = unverified();
    renderConsole(api, "/console/");
    const region = await screen.findByRole("region", { name: "Verify your email" });
    await userEvent.click(
      within(region).getByRole("button", { name: /Resend verification/ }),
    );
    expect(
      await within(region).findByText(/fresh link is on its way/),
    ).toBeInTheDocument();
    expect(
      api.calls.some((c) => c.path === "/v1/tenant/billing/verification/resend"),
    ).toBe(true);
  });
});

describe("§11.1 — verification gates the first session in the checklist", () => {
  it("the checklist blocks 'start a session' until verified", async () => {
    renderConsole(unverified(), "/console/signup");
    // The unverified notice is prepended…
    await screen.findByRole("region", { name: "Verify your email" });
    // …and the session step is gated, not a live link.
    expect(
      await screen.findByText(/Verify your email to unlock this step/),
    ).toBeInTheDocument();
  });
});

describe("§11.1 — verify-email landing activates the trial", () => {
  it("a valid token reports the now-active $5 trial", async () => {
    const api = unverified();
    renderConsole(api, "/console/verify-email?token=tok_valid");
    await userEvent.click(
      await screen.findByRole("button", { name: /Verify my email/ }),
    );
    expect(
      await screen.findByText(/\$5 trial balance is now active/),
    ).toBeInTheDocument();
    expect(api.billingState?.verificationRequired).toBe(false);
    expect(api.ledgerEntries.some((e) => e.kind === "grant")).toBe(true);
  });
});
