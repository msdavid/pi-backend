/**
 * Tenant dashboard feature tests (WP-C3.6; console-spec §9.9, journey W14):
 * quota-vs-limit pairs render per the backend's own mapping, the usage table
 * follows the RESPONSE's `groupBy` (agent id links to the agent detail
 * route; a null userId is labeled), the granularity/groupBy pickers drive
 * the query params, and the CSV export reproduces the fetched rows verbatim
 * (§11.9: no client-side money math — `String(n)`, no rounding).
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantUsageBucket } from "@pi-managed/contracts";

import {
  FakeConsoleApi,
  makeTenantInfo,
  makeTenantUsage,
} from "../../test/fake-console-api.js";
import { renderConsole } from "../../test/render-console.js";
import { axe } from "../../ui/test-utils.js";
import { buildUsageCsv, usageCsvFilename } from "./tenant-usage.js";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const TENANT = "/console/settings/tenant";

function bucket(overrides: Partial<TenantUsageBucket>): TenantUsageBucket {
  return {
    bucketStart: "2026-07-01T00:00:00.000Z",
    inputTokens: 1000,
    outputTokens: 200,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    usdCost: 0.0123456,
    ...overrides,
  };
}

describe("quota vs limit (§9.9)", () => {
  it("pairs every usage figure with its plan ceiling (backend quota mapping)", async () => {
    const api = FakeConsoleApi.signedIn(["read"]);
    api.tenantInfo = makeTenantInfo({
      quotaUsage: {
        concurrentSessions: 3,
        concurrentSandboxes: 2,
        jobs: 42,
        vaultSize: 5,
        memorySize: 7,
        fileStorage: 5_368_709_120,
        tokenSpendUsd: 12.34,
      },
    });
    renderConsole(api, TENANT);

    const table = await screen.findByRole("table", { name: "Quota vs limit" });
    const expectRow = (resource: string, used: string, limit: string) => {
      const row = within(table).getByText(resource).closest("tr")!;
      const cells = within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent);
      expect(cells.slice(0, 3)).toEqual([resource, used, limit]);
    };
    expectRow("Concurrent sessions", "3", "10");
    expectRow("Concurrent sandboxes", "2", "10");
    expectRow("Jobs", "42", "100");
    expectRow("Vault credentials", "5", "100");
    expectRow("Memory stores", "7", "25");
    expectRow("File storage", "5.0 GiB", "10.0 GiB");
    expectRow("Token spend (this month)", "$12.3400", "$200.0000");
  });
});

describe("spend over time (§9.9, §11.5)", () => {
  it("renders the series and refetches on the granularity toggle", async () => {
    const user = userEvent.setup();
    const api = FakeConsoleApi.signedIn(["read"]);
    api.tenantUsage = makeTenantUsage({
      data: [
        bucket({}),
        bucket({ bucketStart: "2026-07-02T00:00:00.000Z", usdCost: 0.5 }),
      ],
    });
    renderConsole(api, TENANT);

    const table = await screen.findByRole("table", { name: "Usage over time" });
    expect(within(table).getByText("2026-07-01")).toBeInTheDocument();
    expect(within(table).getByText("$0.0123")).toBeInTheDocument();
    expect(within(table).getByText("$0.5000")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Granularity"), "month");
    await waitFor(() =>
      expect(
        api.calls.some(
          (c) =>
            c.method === "GET" &&
            c.path === "/v1/tenant/usage?granularity=month",
        ),
      ).toBe(true),
    );
  });

  it("groupBy=agent: the picker sends the param; agent ids link to the detail route", async () => {
    const user = userEvent.setup();
    const api = FakeConsoleApi.signedIn(["read"]);
    api.tenantUsage = makeTenantUsage({
      groupBy: "agent",
      data: [bucket({ agentId: "agent_01BREAKDOWN" })],
    });
    renderConsole(api, TENANT);

    // Columns follow the RESPONSE's groupBy — display what the API reports.
    const table = await screen.findByRole("table", { name: "Usage over time" });
    expect(within(table).getByText("Agent")).toBeInTheDocument();
    const link = within(table).getByRole("link", {
      name: /agent_01BREAKDOWN/,
    });
    expect(link).toHaveAttribute(
      "href",
      "/console/agents/agent_01BREAKDOWN",
    );

    await user.selectOptions(screen.getByLabelText("Break down by"), "agent");
    await waitFor(() =>
      expect(
        api.calls.some(
          (c) =>
            c.method === "GET" &&
            c.path === "/v1/tenant/usage?granularity=day&groupBy=agent",
        ),
      ).toBe(true),
    );
  });

  it("groupBy=user: renders userIds and labels the null (no metadata.userId) rows", async () => {
    const api = FakeConsoleApi.signedIn(["read"]);
    api.tenantUsage = makeTenantUsage({
      groupBy: "user",
      data: [
        bucket({ userId: "u_alice" }),
        bucket({ userId: null, usdCost: 0.2 }),
      ],
    });
    renderConsole(api, TENANT);

    const table = await screen.findByRole("table", { name: "Usage over time" });
    expect(within(table).getByText("u_alice")).toBeInTheDocument();
    expect(within(table).getByText("(no userId)")).toBeInTheDocument();
  });

  it("teaching empty state + disabled export with the reason (C§6.1)", async () => {
    renderConsole(FakeConsoleApi.signedIn(["read"]), TENANT);
    expect(await screen.findByText("No spend in this range")).toBeInTheDocument();
    const exportButton = screen.getByRole("button", { name: "Download CSV" });
    expect(exportButton).toBeDisabled();
    expect(
      screen.getByText(/nothing to export — no rows in this range/),
    ).toBeInTheDocument();
  });

  it("is axe-clean", async () => {
    const api = FakeConsoleApi.signedIn(["read"]);
    api.tenantUsage = makeTenantUsage({ data: [bucket({})] });
    const { view } = renderConsole(api, TENANT);
    await screen.findByRole("table", { name: "Usage over time" });
    expect(await axe(view.container)).toHaveNoViolations();
  });
});

describe("CSV export (§9.9; §11.9 export-what-the-API-returned)", () => {
  it("downloads the fetched rows verbatim as CSV — no rounding, no totals", async () => {
    const user = userEvent.setup();
    const api = FakeConsoleApi.signedIn(["read"]);
    api.tenantUsage = makeTenantUsage({
      data: [
        bucket({}),
        bucket({ bucketStart: "2026-07-02T00:00:00.000Z", usdCost: 0.5 }),
      ],
    });
    renderConsole(api, TENANT);
    await screen.findByRole("table", { name: "Usage over time" });

    // jsdom has no object-URL registry; shim it to capture the Blob (a DOM
    // shim for a browser API jsdom lacks — the network seam is untouched).
    const blobs: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob | MediaSource): string => {
      blobs.push(blob as Blob);
      return "blob:console-test";
    });
    URL.revokeObjectURL = vi.fn();
    const anchors: Array<{ download: string; href: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      function (this: HTMLAnchorElement) {
        anchors.push({ download: this.download, href: this.href });
      } as () => void,
    );

    await user.click(screen.getByRole("button", { name: "Download CSV" }));

    expect(anchors).toEqual([
      { download: "tenant-usage-day.csv", href: "blob:console-test" },
    ]);
    expect(blobs).toHaveLength(1);
    const csv = await blobs[0]!.text();
    expect(csv).toBe(buildUsageCsv(api.tenantUsage));
    // Raw API numbers, digit for digit (no toFixed anywhere in the export).
    expect(csv).toContain(
      "2026-07-01T00:00:00.000Z,1000,200,0,0,0.0123456",
    );
    expect(csv).toContain("2026-07-02T00:00:00.000Z,1000,200,0,0,0.5");
  });

  it("buildUsageCsv: group column per response; null userId empty; quoting", () => {
    const grouped = makeTenantUsage({
      groupBy: "user",
      data: [
        bucket({ userId: 'weird,"id"' }),
        bucket({ userId: null, usdCost: 0.2 }),
      ],
    });
    expect(buildUsageCsv(grouped)).toBe(
      "bucketStart,userId,inputTokens,outputTokens,cacheCreationInputTokens,cacheReadInputTokens,usdCost\n" +
        '2026-07-01T00:00:00.000Z,"weird,""id""",1000,200,0,0,0.0123456\n' +
        "2026-07-01T00:00:00.000Z,,1000,200,0,0,0.2\n",
    );
    expect(usageCsvFilename(grouped)).toBe("tenant-usage-day-by-user.csv");
    expect(usageCsvFilename(makeTenantUsage({ granularity: "month" }))).toBe(
      "tenant-usage-month.csv",
    );
  });
});
