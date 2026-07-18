/**
 * Self-hosted environment surface tests (WP-C3.2; console-spec §9.2, journey
 * W12): worker keys listed from the api-keys family by scope marker, the
 * show-once mint flow (copy-and-confirm; the raw key NEVER renders twice),
 * live work-stats rendering, and the drain flow where `{force}` is an
 * explicit second step behind a DP-7 typed confirmation.
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { FakeConsoleApi } from "../../test/fake-console-api.js";
import { renderConsole } from "../../test/render-console.js";
import { axe } from "../../ui/test-utils.js";

const DETAIL = "/console/resources/environments/env_01WORKERS";
/** The obviously-fake raw key the fake mints (never a real-looking value). */
const MINTED_KEY = "pmb_live_TESTWORKERKEYNOTASECRET";

beforeEach(() => {
  window.localStorage.clear();
});

function fakeWithWorkersEnv(scopes = ["admin"]): FakeConsoleApi {
  const api = FakeConsoleApi.signedIn(scopes);
  api.addEnvironment({
    id: "env_01WORKERS",
    name: "gpu-workers",
    type: "self_hosted",
  });
  api.addApiKey({
    id: "apikey_01WORKERA",
    name: "worker-host-1",
    scopes: ["self_hosted_worker:env_01WORKERS"],
  });
  // An org key and a foreign worker key must NOT appear in the list.
  api.addApiKey({ id: "apikey_01ORG", name: "org-admin", scopes: ["admin"] });
  api.addApiKey({
    id: "apikey_01OTHERENV",
    name: "worker-elsewhere",
    scopes: ["self_hosted_worker:env_01OTHER"],
  });
  return api;
}

describe("self-hosted worker keys (W12)", () => {
  it("lists only this environment's worker keys and repeats the W12 rule", async () => {
    renderConsole(fakeWithWorkersEnv(), DETAIL);
    const table = await screen.findByRole("table", { name: "Worker keys" });
    expect(within(table).getByText("worker-host-1")).toBeInTheDocument();
    expect(within(table).queryByText("org-admin")).not.toBeInTheDocument();
    expect(
      within(table).queryByText("worker-elsewhere"),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByText(/only key that belongs on a worker host/).length,
    ).toBeGreaterThan(0);
  });

  it("mints show-once: copy-and-confirm, and the key NEVER renders again", async () => {
    const user = userEvent.setup();
    const api = fakeWithWorkersEnv();
    renderConsole(api, DETAIL);
    await screen.findByRole("table", { name: "Worker keys" });

    await user.click(screen.getByRole("button", { name: "Mint worker key" }));
    let dialog = await screen.findByRole("dialog", {
      name: "Mint worker key",
    });
    await user.type(
      within(dialog).getByLabelText("Key name"),
      "worker-host-2",
    );
    await user.click(within(dialog).getByRole("button", { name: "Mint" }));

    // The raw key renders exactly once, with the show-once warning and the
    // W12 rule alongside.
    expect(await within(dialog).findByText(MINTED_KEY)).toBeInTheDocument();
    expect(
      within(dialog).getByText(/shown exactly once/),
    ).toBeInTheDocument();

    // Copy-and-confirm: "I've stored the key" is locked until copied.
    const done = within(dialog).getByRole("button", {
      name: "I've stored the key",
    });
    expect(done).toBeDisabled();
    expect(done).toHaveAccessibleDescription(
      "copy the key first — it will not be shown again",
    );
    await user.click(within(dialog).getByRole("button", { name: "Copy" }));
    expect(await window.navigator.clipboard.readText()).toBe(MINTED_KEY);
    expect(done).toBeEnabled();
    await user.click(done);

    // Gone from the DOM — and reopening the dialog shows the FORM, not the
    // key: the show-once value cannot be re-rendered (DP-8).
    expect(screen.queryByText(MINTED_KEY)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Mint worker key" }));
    dialog = await screen.findByRole("dialog", { name: "Mint worker key" });
    expect(within(dialog).getByLabelText("Key name")).toBeInTheDocument();
    expect(within(dialog).queryByText(MINTED_KEY)).not.toBeInTheDocument();

    // Exactly ONE mint call reached the API.
    expect(
      api.calls.filter(
        (c) =>
          c.method === "POST" &&
          c.path === "/v1/environments/env_01WORKERS/worker-keys",
      ),
    ).toHaveLength(1);
  });

  it("read scope: mint is disabled WITH its reason (§6.1)", async () => {
    renderConsole(fakeWithWorkersEnv(["read"]), DETAIL);
    await screen.findByRole("table", { name: "Worker keys" });
    const mint = screen.getByRole("button", { name: "Mint worker key" });
    expect(mint).toBeDisabled();
    // §6.2: the reason names the scope the backend ACTUALLY requires (the
    // mint route is POST /v1/environments/:id/worker-keys — method→scope).
    expect(mint).toHaveAccessibleDescription("requires the write scope");
  });

  it("write scope: mint is enabled (§6.2 — write, not admin)", async () => {
    renderConsole(fakeWithWorkersEnv(["read", "write"]), DETAIL);
    await screen.findByRole("table", { name: "Worker keys" });
    expect(
      screen.getByRole("button", { name: "Mint worker key" }),
    ).toBeEnabled();
  });
});

describe("self-hosted work-stats (§9.2)", () => {
  it("renders depth, pending, oldest queued, and workers polling", async () => {
    const api = fakeWithWorkersEnv();
    api.workStats.set("env_01WORKERS", {
      depth: 3,
      pending: 2,
      oldestQueuedAt: "2026-07-15T10:00:00.000Z",
      workersPolling: 1,
    });
    renderConsole(api, DETAIL);

    const panel = await screen.findByRole("region", { name: "Work queue" });
    expect(await within(panel).findByText("depth")).toBeInTheDocument();
    expect(within(panel).getByText("depth").nextSibling).toHaveTextContent("3");
    expect(within(panel).getByText("pending").nextSibling).toHaveTextContent(
      "2",
    );
    expect(
      within(panel).getByText("oldest queued").nextSibling,
    ).toHaveTextContent("2026-07-15 10:00:00Z");
    expect(
      within(panel).getByText("workers polling").nextSibling,
    ).toHaveTextContent("1");
  });

  it("an idle queue renders the zero shape", async () => {
    renderConsole(fakeWithWorkersEnv(), DETAIL);
    const panel = await screen.findByRole("region", { name: "Work queue" });
    expect(await within(panel).findByText("depth")).toBeInTheDocument();
    expect(within(panel).getByText("depth").nextSibling).toHaveTextContent("0");
    expect(
      within(panel).getByText("oldest queued").nextSibling,
    ).toHaveTextContent("—");
  });
});

describe("self-hosted drain (§9.2: force is the second step)", () => {
  it("clean stop first; force unlocks only after, behind a typed confirmation", async () => {
    const user = userEvent.setup();
    const api = fakeWithWorkersEnv();
    renderConsole(api, DETAIL);
    const panel = await screen.findByRole("region", { name: "Drain work" });

    const force = within(panel).getByRole("button", { name: "Force stop…" });
    await user.type(
      within(panel).getByLabelText("Session id"),
      "sess_01STUCK",
    );
    // Not yet: force is the SECOND step, and says so.
    expect(force).toBeDisabled();
    expect(force).toHaveAccessibleDescription(
      "request a clean stop first — force is the second step",
    );

    await user.click(
      within(panel).getByRole("button", { name: "Request clean stop" }),
    );
    await screen.findByText("Clean stop requested for sess_01STUCK");
    const clean = api.calls.find(
      (c) =>
        c.method === "POST" &&
        c.path === "/v1/environments/env_01WORKERS/work-stop",
    );
    expect(clean?.body).toEqual({ sessionId: "sess_01STUCK" });

    // Force is now unlocked but still gated by the DP-7 typed dialog.
    expect(force).toBeEnabled();
    await user.click(force);
    const dialog = await screen.findByRole("dialog", {
      name: "Force stop work",
    });
    expect(
      within(dialog).getByText(/interrupts mid-execution/),
    ).toBeInTheDocument();
    await user.type(
      within(dialog).getByLabelText('Type "gpu-workers" to confirm'),
      "gpu-workers",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Force stop" }),
    );
    await screen.findByText("Force stop requested for sess_01STUCK");

    const stops = api.calls.filter(
      (c) =>
        c.method === "POST" &&
        c.path === "/v1/environments/env_01WORKERS/work-stop",
    );
    expect(stops).toHaveLength(2);
    expect(stops[1]?.body).toEqual({
      sessionId: "sess_01STUCK",
      force: true,
    });
  });

  it("changing the session id re-locks force (the second step is per-session)", async () => {
    const user = userEvent.setup();
    renderConsole(fakeWithWorkersEnv(), DETAIL);
    const panel = await screen.findByRole("region", { name: "Drain work" });

    const input = within(panel).getByLabelText("Session id");
    await user.type(input, "sess_01STUCK");
    await user.click(
      within(panel).getByRole("button", { name: "Request clean stop" }),
    );
    await screen.findByText("Clean stop requested for sess_01STUCK");
    const force = within(panel).getByRole("button", { name: "Force stop…" });
    expect(force).toBeEnabled();

    await user.clear(input);
    await user.type(input, "sess_01OTHER");
    expect(force).toBeDisabled();
  });

  it("is axe-clean", async () => {
    const { view } = renderConsole(fakeWithWorkersEnv(), DETAIL);
    await screen.findByRole("region", { name: "Drain work" });
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
