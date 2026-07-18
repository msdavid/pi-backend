/**
 * Job lifecycle tests (WP-C3.5; console-spec §9.4, §17.5):
 * pause/unpause round-trip with the reason display, the DP-7 archive
 * dialog (typed confirmation, real consequences), write gating (§6.2) with
 * a visible reason (§6.1), and the terminal archived state.
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { FakeConsoleApi } from "../../test/fake-console-api.js";
import { renderConsole } from "../../test/render-console.js";
import { axe } from "../../ui/test-utils.js";

beforeEach(() => {
  window.localStorage.clear();
});

function fakeWithJob(
  scopes: string[],
  overrides: Parameters<FakeConsoleApi["addJob"]>[0] = { id: "job_01NIGHTLY" },
): FakeConsoleApi {
  const api = FakeConsoleApi.signedIn(scopes);
  api.addJob({ name: "nightly-e2e", ...overrides });
  return api;
}

describe("job lifecycle (§9.4, write-gated, §17.5)", () => {
  it("admin pauses an active job; the manual-pause reason then displays", async () => {
    const user = userEvent.setup();
    const api = fakeWithJob(["admin"]);
    renderConsole(api, "/console/jobs/job_01NIGHTLY");

    await user.click(await screen.findByRole("button", { name: "Pause" }));

    expect(api.calls).toContainEqual({
      method: "POST",
      path: "/v1/jobs/job_01NIGHTLY/pause",
      body: {},
    });
    // §9.4: the pause reason displays prominently, and the toggle flips.
    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain("Paused manually.");
    expect(banner.textContent).toContain("not backfilled");
    expect(
      await screen.findByRole("button", { name: "Unpause" }),
    ).toBeInTheDocument();
  });

  it("admin unpauses a paused job; the pause banner clears", async () => {
    const user = userEvent.setup();
    const api = fakeWithJob(["admin"], {
      id: "job_01NIGHTLY",
      status: "paused",
      pausedReason: { type: "manual" },
    });
    renderConsole(api, "/console/jobs/job_01NIGHTLY");

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Paused manually.",
    );
    await user.click(await screen.findByRole("button", { name: "Unpause" }));

    expect(api.calls).toContainEqual({
      method: "POST",
      path: "/v1/jobs/job_01NIGHTLY/unpause",
      body: {},
    });
    expect(
      await screen.findByRole("button", { name: "Pause" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Paused manually.")).not.toBeInTheDocument();
    expect(
      await screen.findByText(/Job unpaused — resumes at the next occurrence/),
    ).toBeInTheDocument();
  });

  it("archive requires retyping the name in a DP-7 dialog naming the consequences", async () => {
    const user = userEvent.setup();
    const api = fakeWithJob(["admin"]);
    const { router } = renderConsole(api, "/console/jobs/job_01NIGHTLY");

    await user.click(await screen.findByRole("button", { name: "Archive" }));
    const dialog = await screen.findByRole("dialog", { name: "Archive job" });
    // Real consequences, sourced from API behavior (terminal + hidden from
    // reads — job-service.ts §17.5).
    expect(dialog.textContent).toContain("terminal");
    expect(dialog.textContent).toContain("schedule stops permanently");
    expect(dialog.textContent).toContain(
      "disappears from the console and API reads",
    );

    // The destructive button stays disabled until the exact name is typed.
    const confirm = within(dialog).getByRole("button", { name: "Archive job" });
    expect(confirm).toBeDisabled();
    const input = within(dialog).getByLabelText('Type "nightly-e2e" to confirm');
    await user.type(input, "nightly");
    expect(confirm).toBeDisabled();
    await user.clear(input);
    await user.type(input, "nightly-e2e");
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    expect(api.calls).toContainEqual({
      method: "POST",
      path: "/v1/jobs/job_01NIGHTLY/archive",
      body: {},
    });
    // The detail read would now 404 (archived jobs are invisible) — the
    // flow lands back on the list, where the job no longer appears.
    expect(
      await screen.findByText(/archived — schedule stopped/),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/jobs");
    // The only job is archived → the refetched list is empty (the fake
    // hides archived jobs like the real backend).
    expect(await screen.findByText("No scheduled jobs yet")).toBeInTheDocument();
    expect(screen.queryByText("nightly-e2e")).not.toBeInTheDocument();
  });

  it("read scope: lifecycle buttons are disabled with the reason (§6.1/§6.2)", async () => {
    renderConsole(fakeWithJob(["read"]), "/console/jobs/job_01NIGHTLY");

    const pause = await screen.findByRole("button", { name: "Pause" });
    const archive = screen.getByRole("button", { name: "Archive" });
    expect(pause).toBeDisabled();
    expect(archive).toBeDisabled();
    // §6.2: the reason names the scope the backend ACTUALLY requires.
    expect(pause).toHaveAccessibleDescription("requires the write scope");
    expect(archive).toHaveAccessibleDescription("requires the write scope");
  });

  it("write scope: lifecycle mutations are enabled and go through (§6.2 — write, not admin)", async () => {
    const user = userEvent.setup();
    const api = fakeWithJob(["read", "write"]);
    renderConsole(api, "/console/jobs/job_01NIGHTLY");

    expect(screen.queryByText("requires the write scope")).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Run now" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Archive" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Pause" }));
    expect(api.calls).toContainEqual({
      method: "POST",
      path: "/v1/jobs/job_01NIGHTLY/pause",
      body: {},
    });
  });

  it("is axe-clean with the archive dialog open", async () => {
    const user = userEvent.setup();
    const { view } = renderConsole(
      fakeWithJob(["admin"]),
      "/console/jobs/job_01NIGHTLY",
    );
    await user.click(await screen.findByRole("button", { name: "Archive" }));
    await screen.findByRole("dialog", { name: "Archive job" });
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
