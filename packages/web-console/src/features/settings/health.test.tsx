/**
 * Backend health feature tests (WP-C3.6; console-spec §5.1 + decision 4):
 * the widget probes /healthz + /readyz in solo/team, renders per-dependency
 * readiness (including the 503 not_ready body), and does NOT exist in saas —
 * no probe fires, the page states the decision, and Settings offers no
 * Health entry. The probe transport is faked via the {@link HealthProber}
 * capability on the injected client (the `session-stream.ts` duck-typing
 * pattern) — never by stubbing `fetch`.
 */
import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import type {
  HealthPath,
  HealthProbeResponse,
  HealthProber,
} from "../../api/health.js";
import { FakeConsoleApi, FAKE_TENANT } from "../../test/fake-console-api.js";
import { renderConsole } from "../../test/render-console.js";
import { axe } from "../../ui/test-utils.js";

beforeEach(() => {
  window.localStorage.clear();
});

/** The collaborator fake, extended with the health-probe capability. */
class FakeConsoleApiWithHealth extends FakeConsoleApi implements HealthProber {
  healthzResponse: HealthProbeResponse = {
    status: 200,
    body: { status: "ok" },
  };
  readyzResponse: HealthProbeResponse = {
    status: 200,
    body: {
      status: "ready",
      checks: {
        db: { status: "up" },
        objectStore: { status: "up" },
        sandbox: { status: "up" },
      },
    },
  };
  /** Every probe the page fired, in order. */
  readonly probes: HealthPath[] = [];

  async probeHealth(path: HealthPath): Promise<HealthProbeResponse> {
    this.probes.push(path);
    return path === "/healthz" ? this.healthzResponse : this.readyzResponse;
  }

  static withHealth(scopes: string[]): FakeConsoleApiWithHealth {
    const api = new FakeConsoleApiWithHealth();
    api.signedIn = { scopes, tenant: FAKE_TENANT };
    return api;
  }
}

const HEALTH = "/console/settings/health";

describe("backend health widget (§5.1, solo/team)", () => {
  it("probes both endpoints and renders liveness + per-dependency readiness", async () => {
    const api = FakeConsoleApiWithHealth.withHealth(["read"]);
    renderConsole(api, HEALTH);

    expect(
      await screen.findByText("the backend process is serving requests"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("every dependency reports up"),
    ).toBeInTheDocument();

    const table = screen.getByRole("table", { name: "Readiness checks" });
    for (const name of ["db", "objectStore", "sandbox"]) {
      const row = within(table).getByText(name).closest("tr")!;
      expect(within(row).getByText("up")).toBeInTheDocument();
    }
    expect(api.probes).toContain("/healthz");
    expect(api.probes).toContain("/readyz");
  });

  it("renders the 503 not_ready body: overall state + the down check's detail", async () => {
    const api = FakeConsoleApiWithHealth.withHealth(["read"]);
    api.readyzResponse = {
      status: 503,
      body: {
        status: "not_ready",
        checks: {
          db: { status: "down", detail: "connection refused" },
          objectStore: { status: "up" },
        },
      },
    };
    renderConsole(api, HEALTH);

    expect(
      await screen.findByText("at least one dependency reports down"),
    ).toBeInTheDocument();
    expect(screen.getByText("not_ready")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Readiness checks" });
    const dbRow = within(table).getByText("db").closest("tr")!;
    expect(within(dbRow).getByText("down")).toBeInTheDocument();
    expect(within(dbRow).getByText("connection refused")).toBeInTheDocument();
  });

  it("is axe-clean", async () => {
    const { view } = renderConsole(
      FakeConsoleApiWithHealth.withHealth(["read"]),
      HEALTH,
    );
    await screen.findByRole("table", { name: "Readiness checks" });
    expect(await axe(view.container)).toHaveNoViolations();
  });
});

describe("saas mode (decision 4): the widget does not exist", () => {
  it("states the decision, fires no probe, and Settings offers no Health entry", async () => {
    const api = FakeConsoleApiWithHealth.withHealth(["read"]);
    api.config = { mode: "saas", onboardingEnabled: false };
    renderConsole(api, HEALTH);

    expect(
      await screen.findByText(/no in-product health widget in saas mode/),
    ).toBeInTheDocument();
    // The §5.4 mode difference is the page variant + the absent nav item…
    const subnav = screen.getByRole("navigation", {
      name: "Settings sections",
    });
    expect(
      within(subnav).queryByRole("link", { name: "Health" }),
    ).not.toBeInTheDocument();
    // …and, critically, the deep-linked page never probes.
    expect(api.probes).toEqual([]);
  });
});
