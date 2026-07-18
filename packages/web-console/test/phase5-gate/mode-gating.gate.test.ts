/**
 * Phase-5 gate — §11.8 / §5: Billing is a saas-ONLY surface. The submenu link
 * appears only in saas; the /settings/billing route stays registered in every
 * mode (deep links resolve) but out of saas states why it is empty and fires
 * ZERO billing probes (self-hosters are never balance-gated).
 */
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ConsoleConfig } from "@pi-managed/contracts";

import { FakeConsoleApi } from "../../src/test/fake-console-api.js";
import { renderConsole } from "../../src/test/render-console.js";
import "../../src/ui/test-utils.js"; // afterEach(cleanup)

function admin(config: ConsoleConfig): FakeConsoleApi {
  const api = FakeConsoleApi.signedIn(["admin"]);
  api.config = config;
  return api;
}

describe("§11.8 — the Billing submenu item is saas-only", () => {
  it("saas: Settings shows a Billing link", async () => {
    renderConsole(admin({ mode: "saas", onboardingEnabled: true }), "/console/settings");
    const nav = await screen.findByRole("navigation", { name: "Settings sections" });
    // The link appears once /console/config resolves the mode.
    expect(
      await within(nav).findByRole("link", { name: "Billing" }),
    ).toBeInTheDocument();
  });

  for (const mode of ["solo", "team"] as const) {
    it(`${mode}: Settings has no Billing link`, async () => {
      const { queryClient } = renderConsole(
        admin({ mode, onboardingEnabled: false }),
        "/console/settings",
      );
      const nav = await screen.findByRole("navigation", { name: "Settings sections" });
      // Let the mode resolve first, so absence is a real gate, not a race.
      await waitFor(() => expect(queryClient.isFetching()).toBe(0));
      expect(within(nav).queryByRole("link", { name: "Billing" })).toBeNull();
    });
  }
});

describe("§11.8 — /settings/billing resolves in every mode, gated at render", () => {
  it("saas: renders the balance surface", async () => {
    const api = admin({ mode: "saas", onboardingEnabled: true });
    renderConsole(api, "/console/settings/billing");
    // 404 → "not provisioned" (this fake tenant has no billing state seeded),
    // which is still the saas surface, not the out-of-mode message.
    expect(await screen.findByText(/isn't provisioned/)).toBeInTheDocument();
  });

  for (const mode of ["solo", "team"] as const) {
    it(`${mode}: states the decision and fires no billing probe`, async () => {
      const api = admin({ mode, onboardingEnabled: false });
      const { queryClient } = renderConsole(api, "/console/settings/billing");
      expect(
        await screen.findByText(/Billing is a saas-mode facility/),
      ).toBeInTheDocument();
      await waitFor(() => expect(queryClient.isFetching()).toBe(0));
      expect(
        api.calls.some((c) => c.path.startsWith("/v1/tenant/billing")),
      ).toBe(false);
    });
  }
});
