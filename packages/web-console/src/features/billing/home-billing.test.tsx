/**
 * saas Home commercialization strip (WP-C5.4; console-spec §11.8, W15 steps
 * 1 & 4). Collaborator fake via `<ApiClientProvider>`.
 *
 * Covers: the balance headline + runway render in saas; nothing in solo (never
 * billed); the unverified / low-balance / suspended banners with their single
 * actions.
 */
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConsoleConfig, TenantUsageResponse } from "@pi-managed/contracts";

import {
  FakeConsoleApi,
  makeBillingState,
  makeTenantUsage,
} from "../../test/fake-console-api.js";
import { renderConsole } from "../../test/render-console.js";

const SAAS: ConsoleConfig = { mode: "saas", onboardingEnabled: true };

/** Two day-buckets so the runway projection + sparkline have data. */
function usageWithBurn(): TenantUsageResponse {
  return makeTenantUsage({
    from: "2026-07-01T00:00:00.000Z",
    to: "2026-07-03T00:00:00.000Z",
    data: [
      {
        bucketStart: "2026-07-01T00:00:00.000Z",
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        usdCost: 0.5,
      },
      {
        bucketStart: "2026-07-02T00:00:00.000Z",
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        usdCost: 0.5,
      },
    ],
  });
}

function saasHome(over: (api: FakeConsoleApi) => void): FakeConsoleApi {
  const api = FakeConsoleApi.signedIn(["admin"]);
  api.config = SAAS;
  api.tenantUsage = usageWithBurn();
  over(api);
  return api;
}

beforeEach(() => {
  window.localStorage.clear();
});

// Unmount between tests — with vitest `globals:false` the library's auto-
// cleanup isn't registered, so absence assertions would otherwise see a prior
// render's DOM.
afterEach(cleanup);

describe("saas Home billing strip (§11.8)", () => {
  it("shows balance + runway in saas", async () => {
    const api = saasHome((a) => {
      a.billingState = makeBillingState({ balanceMicros: 5_000_000, balanceUsd: 5 });
    });
    renderConsole(api, "/console/");

    const region = await screen.findByRole("region", { name: "Balance" });
    expect(within(region).getByText("$5.0000")).toBeInTheDocument();
    // $5 at $0.5/day over a 2-day window ⇒ ~10 days.
    expect(within(region).getByText(/lasts ~10 days/)).toBeInTheDocument();
  });

  it("renders nothing in solo mode (self-hosters are never billed)", async () => {
    const api = FakeConsoleApi.signedIn(["admin"]);
    api.config = { mode: "solo", onboardingEnabled: false };
    api.billingState = makeBillingState();
    renderConsole(api, "/console/");

    await screen.findByRole("heading", { name: "Home" });
    expect(screen.queryByRole("region", { name: "Balance" })).toBeNull();
    // No billing probe fires in solo.
    expect(api.calls.some((c) => c.path.startsWith("/v1/tenant/billing"))).toBe(
      false,
    );
  });

  it("shows the low-balance banner when active and near zero", async () => {
    const api = saasHome((a) => {
      a.billingState = makeBillingState({ balanceMicros: 1_500_000, balanceUsd: 1.5 });
    });
    renderConsole(api, "/console/");
    expect(
      await screen.findByRole("region", { name: "Low balance" }),
    ).toBeInTheDocument();
  });

  it("shows the suspended notice + single Top-up action when drained", async () => {
    const api = saasHome((a) => {
      a.billingState = makeBillingState({
        lifecycle: "suspended",
        balanceMicros: 0,
        balanceUsd: 0,
      });
    });
    renderConsole(api, "/console/");
    const region = await screen.findByRole("region", {
      name: "Account suspended",
    });
    expect(within(region).getByRole("link", { name: /Top up/ })).toBeInTheDocument();
  });

  it("shows the unverified notice + resend when the trial is unverified", async () => {
    const api = saasHome((a) => {
      a.billingState = makeBillingState({
        lifecycle: "trial",
        verificationRequired: true,
        verified: false,
        balanceMicros: 0,
        balanceUsd: 0,
      });
    });
    renderConsole(api, "/console/");
    const region = await screen.findByRole("region", { name: "Verify your email" });
    expect(
      within(region).getByRole("button", { name: /Resend verification/ }),
    ).toBeInTheDocument();
  });
});
