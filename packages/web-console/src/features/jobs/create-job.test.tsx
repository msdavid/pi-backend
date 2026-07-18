/**
 * Create-job form tests (WP-C3.5; console-spec §9.4, write-gated §6.2). The API
 * client is a collaborator (fake at the `<ApiClientProvider>` seam); the
 * wire behavior of the create fetcher is contract-tested in
 * `src/api/__tests__/jobs-lifecycle.contract.test.ts`.
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

/** Admin fake with pickable resources (plus archived ones to filter out). */
function adminApi(): FakeConsoleApi {
  const api = FakeConsoleApi.signedIn(["admin"]);
  api.addAgent({ id: "agent_01PICK", name: "code-reviewer" });
  api.addAgent({ id: "agent_01GONE", name: "retired", status: "archived" });
  api.addEnvironment({ id: "env_01PICK", name: "python-env" });
  api.addEnvironment({ id: "env_01GONE", name: "old-env", status: "archived" });
  return api;
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "New job" }));
  return await screen.findByRole("dialog", { name: "New scheduled job" });
}

describe("create job (§9.4, write-gated, WP-C3.5)", () => {
  it("read scope: New job is disabled with the reason (§6.1/§6.2)", async () => {
    renderConsole(FakeConsoleApi.signedIn(["read"]), "/console/jobs");

    const button = await screen.findByRole("button", { name: "New job" });
    expect(button).toBeDisabled();
    // §6.2: the reason names the scope the backend ACTUALLY requires.
    expect(button).toHaveAccessibleDescription("requires the write scope");
  });

  it("write scope enables New job (§6.2 — resource management is a write surface)", async () => {
    renderConsole(FakeConsoleApi.signedIn(["read", "write"]), "/console/jobs");
    expect(await screen.findByRole("button", { name: "New job" })).toBeEnabled();
  });

  it("pickers list only active agents and environments", async () => {
    const user = userEvent.setup();
    const api = adminApi();
    renderConsole(api, "/console/jobs");
    const dialog = await openDialog(user);

    const agentPicker = within(dialog).getByLabelText("Agent");
    await within(agentPicker).findByRole("option", { name: "code-reviewer" });
    expect(
      within(agentPicker).queryByRole("option", { name: "retired" }),
    ).not.toBeInTheDocument();

    const envPicker = within(dialog).getByLabelText("Environment");
    await within(envPicker).findByRole("option", { name: "python-env" });
    expect(
      within(envPicker).queryByRole("option", { name: "old-env" }),
    ).not.toBeInTheDocument();
    // Environments narrow server-side; agents filter client-side (no
    // `?status=` on their list — see `create-job.tsx`).
    expect(
      api.calls.some(
        (c) => c.method === "GET" && c.path.startsWith("/v1/environments?") &&
          c.path.includes("status=active"),
      ),
    ).toBe(true);
  });

  it("submitting an empty form surfaces the required-field errors and does not POST", async () => {
    const user = userEvent.setup();
    const api = adminApi();
    renderConsole(api, "/console/jobs");
    const dialog = await openDialog(user);

    await user.click(within(dialog).getByRole("button", { name: "Create job" }));

    expect(within(dialog).getByText("name is required")).toBeInTheDocument();
    expect(within(dialog).getByText("pick an agent")).toBeInTheDocument();
    expect(within(dialog).getByText("pick an environment")).toBeInTheDocument();
    expect(
      within(dialog).getByText("the first user message is required"),
    ).toBeInTheDocument();
    expect(
      api.calls.filter((c) => c.method === "POST" && c.path === "/v1/jobs"),
    ).toHaveLength(0);
  });

  it("a malformed cron gets an instant client-side error (server stays authority)", async () => {
    const user = userEvent.setup();
    const api = adminApi();
    renderConsole(api, "/console/jobs");
    const dialog = await openDialog(user);

    const cron = within(dialog).getByLabelText("Cron");
    await user.clear(cron);
    await user.type(cron, "every day");

    expect(cron).toBeInvalid();
    expect(
      within(dialog).getByText(/cron expression must have exactly 5 fields/),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Create job" }));
    expect(
      api.calls.filter((c) => c.method === "POST" && c.path === "/v1/jobs"),
    ).toHaveLength(0);
  });

  it("an unknown timezone gets an instant client-side error", async () => {
    const user = userEvent.setup();
    renderConsole(adminApi(), "/console/jobs");
    const dialog = await openDialog(user);

    const tz = within(dialog).getByLabelText("Timezone");
    await user.clear(tz);
    await user.type(tz, "Mars/Olympus_Mons");

    expect(tz).toBeInvalid();
    expect(
      within(dialog).getByText("unknown IANA timezone: Mars/Olympus_Mons"),
    ).toBeInTheDocument();
  });

  it("shows the next-fire preview from the schedule resolver", async () => {
    const user = userEvent.setup();
    renderConsole(adminApi(), "/console/jobs");
    const dialog = await openDialog(user);

    // The prefilled valid example ("0 7 * * *" UTC) previews immediately.
    expect(
      within(dialog).getByText(/daily at 07:00 — next fire/),
    ).toBeInTheDocument();
    expect(dialog.textContent).toMatch(/next fire\s+\d{4}-\d{2}-\d{2} 07:00:00Z/);
  });

  it("valid submit POSTs the JobCreate body and navigates to the new job", async () => {
    const user = userEvent.setup();
    const api = adminApi();
    const { router } = renderConsole(api, "/console/jobs");
    const dialog = await openDialog(user);

    await user.type(within(dialog).getByLabelText("Name"), "nightly-audit");
    await within(dialog).findByRole("option", { name: "code-reviewer" });
    await user.selectOptions(
      within(dialog).getByLabelText("Agent"),
      "agent_01PICK",
    );
    await user.selectOptions(
      within(dialog).getByLabelText("Environment"),
      "env_01PICK",
    );
    await user.type(
      within(dialog).getByLabelText("First message"),
      "Audit the repo",
    );
    const cron = within(dialog).getByLabelText("Cron");
    await user.clear(cron);
    await user.type(cron, "30 6 * * 1-5");
    await user.click(within(dialog).getByLabelText(/One-shot/));
    await user.click(within(dialog).getByRole("button", { name: "Create job" }));

    expect(api.calls).toContainEqual({
      method: "POST",
      path: "/v1/jobs",
      body: {
        name: "nightly-audit",
        agent: "agent_01PICK",
        environmentId: "env_01PICK",
        initialEvents: [{ type: "user.message", content: "Audit the repo" }],
        schedule: { cron: "30 6 * * 1-5", tz: "UTC" },
        oneShot: true,
      },
    });
    // Toast + navigation to the created job's detail route.
    expect(
      await screen.findByText("Job nightly-audit created"),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/jobs/job_01TESTNEW1");
    expect(
      await screen.findByRole("heading", { name: "nightly-audit" }),
    ).toBeInTheDocument();
  });

  it("is axe-clean with the dialog open", async () => {
    const user = userEvent.setup();
    const { view } = renderConsole(adminApi(), "/console/jobs");
    await openDialog(user);
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
