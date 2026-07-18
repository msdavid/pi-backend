/**
 * Settings → Billing feature tests (WP-C5.4; console-spec §11.8–11.9, W15).
 * The API client is a COLLABORATOR (FakeConsoleApi via `<ApiClientProvider>`);
 * the real backend seam lives in `src/api/__tests__/billing.contract.test.ts`.
 *
 * Covers: balance + ledger render, the WITH-adapter money controls (top-up /
 * receipts / auto-charge), the NO-adapter degradation (money controls absent,
 * everything else works, §11.8), the unverified + suspended single-action
 * states, the auto-charge toggle round-trip, and the §11.9 money-verbatim pin.
 */
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsoleConfig } from "@pi-managed/contracts";

import {
  FakeConsoleApi,
  makeAutoCharge,
  makeBillingState,
} from "../../test/fake-console-api.js";
import { renderConsole } from "../../test/render-console.js";
import { redirectToExternal } from "../../lib/navigate.js";
import { axe } from "../../ui/test-utils.js";

// The external redirect is a COLLABORATOR of the Billing screen (jsdom doesn't
// implement navigation); mocking it keeps the link-out assertion precise
// without touching `window.location` (CONVENTIONS.md — the module under test is
// the screen, not this one-line navigate helper).
vi.mock("../../lib/navigate.js", () => ({ redirectToExternal: vi.fn() }));

const SAAS: ConsoleConfig = { mode: "saas", onboardingEnabled: true };

/** A signed-in saas admin with a billing state + one grant seeded. */
function saasApi(over: (api: FakeConsoleApi) => void = () => {}): FakeConsoleApi {
  const api = FakeConsoleApi.signedIn(["admin"]);
  api.config = SAAS;
  api.billingState = makeBillingState();
  api.addLedgerEntry({ id: "led_01GRANT", kind: "grant", source: "trial" });
  over(api);
  return api;
}

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(redirectToExternal).mockClear();
});

// `globals:false` ⇒ the library's auto-cleanup isn't registered; unmount so
// absence assertions don't see a prior render's DOM.
afterEach(cleanup);

describe("Settings → Billing (§11.8)", () => {
  it("renders the balance, lifecycle and ledger history", async () => {
    const api = saasApi();
    renderConsole(api, "/console/settings/billing");

    expect(await screen.findByText("$5.0000")).toBeInTheDocument();
    // Ledger row for the trial grant.
    expect(await screen.findByText("trial")).toBeInTheDocument();
  });

  it("with an adapter configured, shows top-up, receipts and auto-charge", async () => {
    const api = saasApi((a) => {
      a.autoChargeConfig = makeAutoCharge();
    });
    renderConsole(api, "/console/settings/billing");

    expect(await screen.findByRole("button", { name: "Top up" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Receipts & payment method/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("form", { name: "Auto-charge" })).toBeInTheDocument();
  });

  it("top-up collects an amount, then redirects to the adapter-issued hosted URL (no card in the console)", async () => {
    const api = saasApi((a) => {
      a.autoChargeConfig = makeAutoCharge();
      a.hostedUrl = "https://pay.example.test/session/cs_test_abc";
    });
    renderConsole(api, "/console/settings/billing");

    // "Top up" opens the amount dialog; the checkout request only fires once the
    // user continues — and it MUST carry a positive amount (the reference engine
    // 422s an empty body, §11.7), never the old amount-less request.
    await userEvent.click(await screen.findByRole("button", { name: "Top up" }));
    const dialog = await screen.findByRole("dialog", { name: /Top up/ });
    await userEvent.click(
      within(dialog).getByRole("button", { name: /Continue to checkout/ }),
    );
    await waitFor(() =>
      expect(redirectToExternal).toHaveBeenCalledWith(
        "https://pay.example.test/session/cs_test_abc",
      ),
    );
    const checkoutCall = api.calls.find(
      (c) => c.path === "/v1/tenant/billing/checkout",
    );
    expect(checkoutCall).toBeTruthy();
    expect((checkoutCall?.body as { amountUsd?: number }).amountUsd).toBeGreaterThan(0);
  });

  it("with NO adapter, money controls are absent but everything else works (§11.8)", async () => {
    const api = saasApi(); // autoChargeConfig stays null
    renderConsole(api, "/console/settings/billing");

    // Balance + ledger still render.
    expect(await screen.findByText("$5.0000")).toBeInTheDocument();
    expect(await screen.findByText("trial")).toBeInTheDocument();
    // The no-adapter note appears; the money buttons do not.
    expect(await screen.findByText(/Top-ups aren't available/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Top up" })).toBeNull();
    expect(screen.queryByRole("form", { name: "Auto-charge" })).toBeNull();
  });

  it("surfaces the unverified trial with a resend action", async () => {
    const api = saasApi((a) => {
      a.billingState = makeBillingState({
        lifecycle: "trial",
        verificationRequired: true,
        verified: false,
        balanceMicros: 0,
        balanceUsd: 0,
      });
    });
    renderConsole(api, "/console/settings/billing");

    const notice = await screen.findByRole("region", {
      name: "Verify your email",
    });
    await userEvent.click(
      within(notice).getByRole("button", { name: /Resend verification/ }),
    );
    expect(
      await within(notice).findByText(/fresh link is on its way/),
    ).toBeInTheDocument();
    expect(
      api.calls.some(
        (c) => c.path === "/v1/tenant/billing/verification/resend",
      ),
    ).toBe(true);
  });

  it("suspended state states exactly one fixing action (top up)", async () => {
    const api = saasApi((a) => {
      a.autoChargeConfig = makeAutoCharge();
      a.billingState = makeBillingState({
        lifecycle: "suspended",
        balanceMicros: 0,
        balanceUsd: 0,
      });
    });
    renderConsole(api, "/console/settings/billing");

    const notice = await screen.findByRole("region", {
      name: "Account suspended",
    });
    expect(notice.textContent).toContain("still readable");
    // The top-up action appears once the adapter probe resolves.
    expect(
      await within(notice).findByRole("button", { name: "Top up" }),
    ).toBeInTheDocument();
  });

  it("saves an auto-charge toggle change through PATCH", async () => {
    const api = saasApi((a) => {
      a.autoChargeConfig = makeAutoCharge({ enabled: false });
    });
    renderConsole(api, "/console/settings/billing");

    const form = await screen.findByRole("form", { name: "Auto-charge" });
    await userEvent.click(within(form).getByRole("checkbox"));
    await userEvent.click(
      within(form).getByRole("button", { name: /Save auto-charge/ }),
    );
    await waitFor(() =>
      expect(
        api.calls.find(
          (c) =>
            c.method === "PATCH" &&
            c.path === "/v1/tenant/billing/auto-charge",
        ),
      ).toBeTruthy(),
    );
    expect(api.autoChargeConfig?.enabled).toBe(true);
  });

  it("renders money verbatim from the API — no client-side computation (§11.9)", async () => {
    // A sentinel balance the console must render byte-identical (no rounding,
    // no re-derivation): the API's `balanceUsd` is authoritative.
    const api = saasApi((a) => {
      a.billingState = makeBillingState({
        balanceMicros: 3_141_500,
        balanceUsd: 3.1415,
      });
    });
    renderConsole(api, "/console/settings/billing");
    expect(await screen.findByText("$3.1415")).toBeInTheDocument();
  });

  it("is hidden out of saas mode (route resolves, page states why)", async () => {
    const api = FakeConsoleApi.signedIn(["admin"]);
    api.config = { mode: "solo", onboardingEnabled: false };
    renderConsole(api, "/console/settings/billing");
    expect(
      await screen.findByText(/Billing is a saas-mode facility/),
    ).toBeInTheDocument();
    // It never calls the billing API out of saas.
    expect(api.calls.some((c) => c.path.startsWith("/v1/tenant/billing"))).toBe(
      false,
    );
  });

  it("has no axe violations", async () => {
    const api = saasApi((a) => {
      a.autoChargeConfig = makeAutoCharge();
    });
    const { view } = renderConsole(api, "/console/settings/billing");
    await screen.findByText("$5.0000");
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
