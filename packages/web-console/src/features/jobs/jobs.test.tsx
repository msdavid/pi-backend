/**
 * Jobs list feature tests (WP-C2.4; console-spec §9.4, journey W7). The API
 * client is a collaborator (fake at the `<ApiClientProvider>` seam); its wire
 * behavior is contract-tested in `src/api/__tests__/`.
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { ConsoleApiError } from "../../api/client.js";
import { FakeConsoleApi } from "../../test/fake-console-api.js";
import { renderConsole } from "../../test/render-console.js";
import { axe } from "../../ui/test-utils.js";

beforeEach(() => {
  window.localStorage.clear();
});

/** An active daily job with runs, plus an auto-paused one. */
function fakeWithJobs(): FakeConsoleApi {
  const api = FakeConsoleApi.signedIn(["read"]);
  api.addJob({
    id: "job_01NIGHTLY",
    name: "nightly-e2e",
    schedule: { cron: "0 7 * * 1-5", tz: "UTC" },
  });
  api.addJobRun("job_01NIGHTLY", {
    id: "jr_01OK",
    sessionId: "sess_01RUNAAA",
  });
  api.addJob({
    id: "job_01PAUSED",
    name: "broken-report",
    status: "paused",
    pausedReason: { type: "error", error: { type: "agent_archived" } },
    schedule: { cron: "0 0 * * *", tz: "UTC" },
  });
  api.addJobRun("job_01PAUSED", {
    id: "jr_01FAIL",
    sessionId: undefined,
    error: { type: "agent_archived" },
  });
  return api;
}

describe("jobs list (§9.4, W7)", () => {
  it("renders the DP-1 columns: name, schedule (phrase + raw cron), status, last run, next fire", async () => {
    renderConsole(fakeWithJobs(), "/console/jobs");
    const table = await screen.findByRole("table", { name: "Jobs" });

    const headers = within(table)
      .getAllByRole("columnheader")
      .map((th) => th.textContent);
    expect(headers).toEqual([
      "Name",
      "Schedule",
      "Status",
      "Last run",
      "Next fire",
    ]);

    const [nightly, paused] = within(table).getAllByRole("row").slice(1);
    expect(within(nightly!).getByText("nightly-e2e")).toBeInTheDocument();
    expect(
      within(nightly!).getByText("weekdays at 07:00"),
    ).toBeInTheDocument();
    expect(
      within(nightly!).getByText("0 7 * * 1-5 · UTC"),
    ).toBeInTheDocument();
    expect(within(nightly!).getByText("active")).toBeInTheDocument();
    // Last-run outcome (own read per row).
    expect(await within(nightly!).findByText("completed")).toBeInTheDocument();
    // Next fire: an active weekday cron always has an occurrence.
    expect(nightly!.textContent).toMatch(/\d{4}-\d{2}-\d{2} 07:00:00Z/);

    // The auto-paused job: paused chip + the §17.4 error type, no next fire.
    // ("agent_archived" appears twice once the last run loads: as the pause
    // reason next to the status chip AND as the failed run's error type.)
    expect(within(paused!).getByText("paused")).toBeInTheDocument();
    expect(await within(paused!).findByText("failed")).toBeInTheDocument();
    expect(within(paused!).getAllByText("agent_archived")).toHaveLength(2);
    const cells = within(paused!).getAllByRole("cell");
    expect(cells[cells.length - 1]!.textContent).toBe("—");
  });

  it("filters by status server-side (fake narrows the result set)", async () => {
    const user = userEvent.setup();
    renderConsole(fakeWithJobs(), "/console/jobs");
    await screen.findByRole("table", { name: "Jobs" });

    await user.selectOptions(screen.getByLabelText("Status"), "paused");
    const table = await screen.findByRole("table", { name: "Jobs" });
    expect(await within(table).findByText("broken-report")).toBeInTheDocument();
    expect(within(table).queryByText("nightly-e2e")).not.toBeInTheDocument();
  });

  it("row activation navigates to the job detail route", async () => {
    const user = userEvent.setup();
    const { router } = renderConsole(fakeWithJobs(), "/console/jobs");
    const table = await screen.findByRole("table", { name: "Jobs" });

    await user.click(within(table).getByText("nightly-e2e"));
    expect(router.state.location.pathname).toBe("/jobs/job_01NIGHTLY");
  });

  it("teaching empty state carries the CLI command (DP-5)", async () => {
    renderConsole(FakeConsoleApi.signedIn(["read"]), "/console/jobs");
    expect(
      await screen.findByText("No scheduled jobs yet"),
    ).toBeInTheDocument();
    expect(screen.getByText("/remote:cron create")).toBeInTheDocument();
  });

  it("list failure renders the DP-9 facts", async () => {
    const api = FakeConsoleApi.signedIn(["read"]);
    api.failGets.set(
      "/v1/jobs",
      new ConsoleApiError("boom", {
        status: 500,
        code: "internal",
        requestId: "req_01FAIL",
      }),
    );
    renderConsole(api, "/console/jobs");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("internal");
    expect(alert.textContent).toContain("req_01FAIL");
  });

  it("is axe-clean", async () => {
    const { view } = renderConsole(fakeWithJobs(), "/console/jobs");
    await screen.findByRole("table", { name: "Jobs" });
    await screen.findAllByText(/completed|failed/);
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
