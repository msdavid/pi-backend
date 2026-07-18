/**
 * Job detail feature tests (WP-C2.4; console-spec §9.4, journey W7),
 * including the plan-acceptance items: an auto-paused job renders its pause
 * reason prominently, and the manual trigger is disabled-with-explanation
 * under `read` scope (§6.1) while `write` can trigger and sees the new run.
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

function fakeWithJob(scopes: string[]): FakeConsoleApi {
  const api = FakeConsoleApi.signedIn(scopes);
  api.addJob({
    id: "job_01NIGHTLY",
    name: "nightly-e2e",
    schedule: { cron: "0 7 * * 1-5", tz: "UTC" },
    sessionConfig: { vaultIds: ["vault_01TEST"] },
  });
  api.addJobRun("job_01NIGHTLY", {
    id: "jr_01OK",
    sessionId: "sess_01RUNAAA",
    scheduledAt: "2026-07-14T07:00:00.000Z",
  });
  api.addJobRun("job_01NIGHTLY", {
    id: "jr_01FAIL",
    sessionId: undefined,
    error: { type: "service_unavailable" },
    scheduledAt: "2026-07-15T07:00:00.000Z",
  });
  return api;
}

describe("job detail (§9.4, W7)", () => {
  it("leads with the DP-1 facts and the definition", async () => {
    renderConsole(fakeWithJob(["read"]), "/console/jobs/job_01NIGHTLY");

    expect(
      await screen.findByRole("heading", { name: "nightly-e2e" }),
    ).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("weekdays at 07:00")).toBeInTheDocument();
    expect(screen.getByText("0 7 * * 1-5 · UTC")).toBeInTheDocument();
    expect(screen.getByTitle("job_01NIGHTLY")).toBeInTheDocument();
    expect(screen.getByTitle("agent_01TESTAGENT")).toBeInTheDocument();
    expect(screen.getByTitle("env_01TESTENV")).toBeInTheDocument();
    // DP-2: the definition payload is collapsed behind the JsonViewer toggle.
    expect(
      screen.getByRole("button", { name: /session config/ }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("renders the runs history with per-run session links (W7)", async () => {
    renderConsole(fakeWithJob(["read"]), "/console/jobs/job_01NIGHTLY");
    const table = await screen.findByRole("table", { name: "Job runs" });

    // Newest first: the failed run leads.
    const [failed, ok] = within(table).getAllByRole("row").slice(1);
    expect(within(failed!).getByText("failed")).toBeInTheDocument();
    expect(
      within(failed!).getByText("service_unavailable"),
    ).toBeInTheDocument();
    expect(within(failed!).getByText("schedule")).toBeInTheDocument();
    expect(within(ok!).getByText("completed")).toBeInTheDocument();
    // The run's session id deep-links to the session detail route (§7.6).
    const link = within(ok!).getByRole("link");
    expect(link).toHaveAttribute("href", "/console/sessions/sess_01RUNAAA");
  });

  it("an auto-paused job shows its pause reason front and center (plan acceptance)", async () => {
    const api = FakeConsoleApi.signedIn(["read"]);
    api.addJob({
      id: "job_01PAUSED",
      name: "broken-report",
      status: "paused",
      pausedReason: { type: "error", error: { type: "agent_archived" } },
    });
    renderConsole(api, "/console/jobs/job_01PAUSED");

    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain("Auto-paused: agent archived.");
    expect(banner.textContent).toContain("the job's agent has been archived");
    expect(banner.textContent).toContain("Manual runs still work");
  });

  it("a manually paused job explains the manual pause", async () => {
    const api = FakeConsoleApi.signedIn(["read"]);
    api.addJob({
      id: "job_01MANUAL",
      name: "on-hold",
      status: "paused",
      pausedReason: { type: "manual" },
    });
    renderConsole(api, "/console/jobs/job_01MANUAL");

    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain("Paused manually.");
    expect(banner.textContent).toContain("not backfilled");
  });

  it("write scope: Run now triggers the run and the runs list picks it up", async () => {
    const user = userEvent.setup();
    const api = fakeWithJob(["read", "write"]);
    renderConsole(api, "/console/jobs/job_01NIGHTLY");

    const button = await screen.findByRole("button", { name: "Run now" });
    expect(button).toBeEnabled();
    await user.click(button);

    // The POST hit the manual-trigger endpoint…
    expect(api.calls).toContainEqual({
      method: "POST",
      path: "/v1/jobs/job_01NIGHTLY/run",
      body: {},
    });
    // …the toast reports the started session…
    expect(
      await screen.findByText("Run triggered — session sess_01TRIGGERED"),
    ).toBeInTheDocument();
    // …and the invalidated runs history shows the manual run.
    const table = await screen.findByRole("table", { name: "Job runs" });
    expect(await within(table).findByText("manual")).toBeInTheDocument();
  });

  it("read scope: Run now is disabled with an explanation (§6.1, plan acceptance)", async () => {
    renderConsole(fakeWithJob(["read"]), "/console/jobs/job_01NIGHTLY");

    const button = await screen.findByRole("button", { name: "Run now" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("requires the write scope");
    // The reason renders visibly too (the lifecycle buttons share the same
    // accurate text since §6.2 — hence getAllByText).
    expect(
      screen.getAllByText("requires the write scope").length,
    ).toBeGreaterThan(0);
  });

  it("a failed trigger renders the DP-9 facts inline", async () => {
    const user = userEvent.setup();
    const api = fakeWithJob(["read", "write"]);
    // Archived-mid-view: the fake 404s the trigger for unknown jobs — force
    // that by removing the job after load. Simplest deterministic failure:
    // point the trigger at an id the fake does not know.
    renderConsole(api, "/console/jobs/job_01NIGHTLY");
    const button = await screen.findByRole("button", { name: "Run now" });
    api.jobs = [];
    await user.click(button);

    const alerts = await screen.findAllByRole("alert");
    expect(
      alerts.some((a) => a.textContent?.includes("not_found")),
    ).toBe(true);
  });

  it("job load failure renders the DP-9 facts with a retry", async () => {
    const api = FakeConsoleApi.signedIn(["read"]);
    api.failGets.set(
      "/v1/jobs/job_01GONE",
      new ConsoleApiError("gone", {
        status: 404,
        code: "not_found",
        requestId: "req_01GONE",
      }),
    );
    renderConsole(api, "/console/jobs/job_01GONE");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("not_found");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("is axe-clean", async () => {
    const { view } = renderConsole(
      fakeWithJob(["read"]),
      "/console/jobs/job_01NIGHTLY",
    );
    await screen.findByRole("table", { name: "Job runs" });
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
