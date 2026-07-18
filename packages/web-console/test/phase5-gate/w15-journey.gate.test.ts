/**
 * Phase-5 gate — journey W15 (top up + auto-charge; console-spec §11.8). The
 * whole saas commercialization flow, achievable in-console:
 *
 *  1. Home shows balance + burn + "lasts ~N days".
 *  2. Top up link-out present WITH an adapter, ABSENT without (§11.8).
 *  3. Auto-charge toggle + visible daily/monthly caps.
 *  4. Suspended state: still readable, one fixing action (DP-9).
 *
 * Collaborator fake (the client); the console↔backend seam is
 * `src/api/__tests__/billing.contract.test.ts`. The external redirect is mocked
 * (jsdom has no navigation) so the link-out assertion is precise.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderConsole } from "../../src/test/render-console.js";
import { redirectToExternal } from "../../src/lib/navigate.js";
import "../../src/ui/test-utils.js"; // afterEach(cleanup)
import { saasBillingApi } from "./helpers.js";

vi.mock("../../src/lib/navigate.js", () => ({ redirectToExternal: vi.fn() }));

describe("W15 §11.8 — balance + burn on Home", () => {
  it("shows balance and 'lasts ~N days' at the current rate", async () => {
    renderConsole(saasBillingApi(), "/console/");
    const region = await screen.findByRole("region", { name: "Balance" });
    expect(within(region).getByText("$5.0000")).toBeInTheDocument();
    // $5 at $0.5/day over the 2-day window ⇒ ~10 days.
    expect(within(region).getByText(/lasts ~10 days/)).toBeInTheDocument();
  });
});

describe("W15 §11.8 — top-up link-out present iff an adapter is configured", () => {
  it("WITH an adapter: Top up redirects to the adapter-issued hosted URL", async () => {
    const api = saasBillingApi({
      withAdapter: true,
      seed: (a) => {
        a.hostedUrl = "https://pay.example.test/session/cs_gate";
      },
    });
    renderConsole(api, "/console/settings/billing");
    // "Top up" opens the amount dialog; continuing requests the hosted URL with a
    // positive amount (the reference engine requires one, §11.7) and redirects.
    await userEvent.click(await screen.findByRole("button", { name: "Top up" }));
    const dialog = await screen.findByRole("dialog", { name: /Top up/ });
    await userEvent.click(
      within(dialog).getByRole("button", { name: /Continue to checkout/ }),
    );
    await waitFor(() =>
      expect(redirectToExternal).toHaveBeenCalledWith(
        "https://pay.example.test/session/cs_gate",
      ),
    );
    // The card is never entered in the console — only a URL is requested, and it
    // carries the top-up amount.
    const checkoutCall = api.calls.find(
      (c) => c.path === "/v1/tenant/billing/checkout",
    );
    expect(checkoutCall).toBeTruthy();
    expect(
      (checkoutCall?.body as { amountUsd?: number }).amountUsd,
    ).toBeGreaterThan(0);
  });

  it("WITHOUT an adapter: money buttons are absent; the rest works (§11.8)", async () => {
    const api = saasBillingApi({ withAdapter: false });
    renderConsole(api, "/console/settings/billing");
    // Balance + ledger still render.
    expect(await screen.findByText("$5.0000")).toBeInTheDocument();
    expect(await screen.findByText("trial")).toBeInTheDocument();
    // The money controls are gone.
    expect(await screen.findByText(/Top-ups aren't available/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Top up" })).toBeNull();
    expect(screen.queryByRole("form", { name: "Auto-charge" })).toBeNull();
  });
});

describe("W15 §11.7 — auto-charge toggle with visible caps", () => {
  it("shows the daily/monthly caps and toggles through PATCH", async () => {
    const api = saasBillingApi({ withAdapter: true });
    renderConsole(api, "/console/settings/billing");
    const form = await screen.findByRole("form", { name: "Auto-charge" });
    // Caps are visible (safety rails, §11.7).
    expect(within(form).getByText("$100.0000")).toBeInTheDocument(); // daily cap
    expect(within(form).getByText("$500.0000")).toBeInTheDocument(); // monthly cap

    await userEvent.click(within(form).getByRole("checkbox"));
    await userEvent.click(
      within(form).getByRole("button", { name: /Save auto-charge/ }),
    );
    await waitFor(() =>
      expect(
        api.calls.some(
          (c) =>
            c.method === "PATCH" && c.path === "/v1/tenant/billing/auto-charge",
        ),
      ).toBe(true),
    );
    expect(api.autoChargeConfig?.enabled).toBe(true);
  });
});

describe("W15 §11.1/§11.8 — suspended is fail-soft with one fixing action", () => {
  it("states everything is readable and offers exactly the top-up action", async () => {
    const api = saasBillingApi({
      withAdapter: true,
      seed: (a) => {
        a.billingState = {
          lifecycle: "suspended",
          balanceMicros: 0,
          balanceUsd: 0,
          verified: true,
          verificationRequired: false,
        };
      },
    });
    renderConsole(api, "/console/settings/billing");
    const notice = await screen.findByRole("region", { name: "Account suspended" });
    expect(notice.textContent).toContain("still readable");
    expect(
      await within(notice).findByRole("button", { name: "Top up" }),
    ).toBeInTheDocument();
  });
});
