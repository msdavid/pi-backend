/**
 * Phase-3 gate — console-spec §5 mode matrix for the phase-3 surfaces.
 * Every mode difference must be a route present/absent, a copy variant, or
 * an emphasis change (§5.4); this file pins the two phase-3 differences:
 *
 * - Health (§5.1, decision 4): solo/team ONLY. The route stays registered
 *   in every mode (deep links resolve, §1.4), but in saas the page states
 *   the decision and fires ZERO probes — proven by counting probe calls on
 *   the injected `HealthProber` capability.
 * - Signup (§5.3/§9.6): the form renders iff saas AND onboardingEnabled;
 *   everywhere else the page points at sign-in. The sign-in page's "create
 *   a tenant" affordance follows the same gate.
 *
 * Feature-level variants (copy, checklist, key-once) live in
 * `src/features/onboarding/signup.test.tsx` and
 * `src/features/settings/health.test.tsx`; the gate pins the matrix itself.
 */
import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import type { ConsoleConfig } from "@pi-managed/contracts";
import { FakeConsoleApi } from "../../src/test/fake-console-api.js";
import { renderConsole } from "../../src/test/render-console.js";
import "../../src/ui/test-utils.js"; // afterEach(cleanup)
import { HealthCapableFake } from "./helpers.js";

function signedIn(config: ConsoleConfig): HealthCapableFake {
  const api = new HealthCapableFake();
  api.signedIn = {
    scopes: ["admin"],
    tenant: { id: "tnt_01TEST", name: "Acme Corp" },
  };
  api.config = config;
  return api;
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("§5.1 — /settings/health is solo/team only", () => {
  for (const mode of ["solo", "team"] as const) {
    it(`${mode}: the widget probes /healthz + /readyz and renders the checks`, async () => {
      const api = signedIn({ mode, onboardingEnabled: false });
      renderConsole(api, "/console/settings/health");
      await screen.findByRole("table", { name: "Readiness checks" });
      expect(
        screen.getByText(/the backend process is serving requests/),
      ).toBeInTheDocument();
      const probes = api.calls.filter((c) => c.method === "PROBE");
      expect(probes.map((p) => p.path).sort()).toEqual([
        "/healthz",
        "/readyz",
      ]);
    });
  }

  it("saas: the page states the decision and fires ZERO probes", async () => {
    const api = signedIn({ mode: "saas", onboardingEnabled: true });
    const { queryClient } = renderConsole(api, "/console/settings/health");
    expect(
      await screen.findByText(/operated by the service provider/),
    ).toBeInTheDocument();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(api.calls.filter((c) => c.method === "PROBE")).toEqual([]);
  });
});

describe("§5.3/§9.6 — /signup renders the form iff saas + onboarding", () => {
  const CASES: Array<{ config: ConsoleConfig; form: boolean }> = [
    { config: { mode: "solo", onboardingEnabled: false }, form: false },
    { config: { mode: "team", onboardingEnabled: false }, form: false },
    { config: { mode: "saas", onboardingEnabled: false }, form: false },
    // The gate is saas AND onboarding: a misconfigured solo/team backend
    // reporting onboardingEnabled must STILL not render the form — these
    // two cases fail if the mode half of the check is dropped.
    { config: { mode: "solo", onboardingEnabled: true }, form: false },
    { config: { mode: "team", onboardingEnabled: true }, form: false },
    { config: { mode: "saas", onboardingEnabled: true }, form: true },
  ];

  for (const { config, form } of CASES) {
    it(`${config.mode} / onboarding ${config.onboardingEnabled}: ${
      form ? "signup form" : "sign-in pointer"
    }`, async () => {
      const api = new FakeConsoleApi(); // signed out — /signup is public
      api.config = config;
      renderConsole(api, "/console/signup");
      await screen.findByRole("heading", { name: "Sign up" });
      if (form) {
        expect(screen.getByLabelText("Tenant name")).toBeInTheDocument();
        expect(screen.getByLabelText("Admin email")).toBeInTheDocument();
      } else {
        expect(
          screen.getByText(/Self-service sign-up is not enabled/),
        ).toBeInTheDocument();
        expect(screen.queryByLabelText("Tenant name")).not.toBeInTheDocument();
      }
    });
  }

  it("the sign-in page offers Create a tenant only under saas + onboarding", async () => {
    const saas = new FakeConsoleApi();
    saas.config = { mode: "saas", onboardingEnabled: true };
    const first = renderConsole(saas, "/console/");
    expect(
      await screen.findByRole("link", { name: /Create a tenant/ }),
    ).toHaveAttribute("href", "/console/signup");
    first.view.unmount();

    const team = new FakeConsoleApi();
    team.config = { mode: "team", onboardingEnabled: false };
    const { queryClient } = renderConsole(team, "/console/");
    await screen.findByLabelText("API key");
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(
      screen.queryByRole("link", { name: /Create a tenant/ }),
    ).not.toBeInTheDocument();
  });
});
