/**
 * Session interaction feature tests (WP-C2.2; console-spec §7.5, journey
 * W4): the blocking-request panel (approve/deny → `user.tool_confirmation`),
 * the steering composer (`user.message`, idle-only), and Interrupt
 * (`user.interrupt`), including the §6.1 rule that a `read` key sees every
 * control disabled WITH the reason, never hidden. The API client is a
 * collaborator (fake at the `<ApiClientProvider>` seam); the wire behavior
 * is contract-tested in `src/api/__tests__/session-events.contract.test.ts`.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { FakeConsoleApi } from "../../test/fake-console-api.js";
import { renderConsole } from "../../test/render-console.js";
import { axe } from "../../ui/test-utils.js";

beforeEach(() => {
  window.localStorage.clear();
});

/** A session idle on `requires_action` with the blocking tool_use in its log. */
function fakeRequiresAction(scopes = ["read", "write"]): FakeConsoleApi {
  const api = FakeConsoleApi.signedIn(scopes);
  api.addSession({
    id: "sess_01WAIT",
    title: "needs a confirmation",
    status: "idle",
    stopReason: "requires_action",
  });
  api.entries.set("sess_01WAIT", [
    {
      seq: 0,
      type: "user.message",
      processedAt: "2026-07-02T10:00:00.000Z",
      content: "clean up the workspace",
    },
    {
      seq: 1,
      type: "agent.tool_use",
      processedAt: "2026-07-02T10:00:01.000Z",
      tool: "bash",
      input: { command: "rm -rf build/" },
      eventId: "evt_01BLOCK",
    },
    {
      seq: 2,
      type: "session.status_idle",
      processedAt: "2026-07-02T10:00:02.000Z",
      stopReason: "requires_action",
      blockingEventIds: ["evt_01BLOCK"],
    },
  ]);
  return api;
}

function fakeWithSession(
  status: "idle" | "running",
  scopes = ["read", "write"],
): FakeConsoleApi {
  const api = FakeConsoleApi.signedIn(scopes);
  api.addSession({ id: "sess_01AAA", title: "some work", status });
  return api;
}

async function renderDetail(api: FakeConsoleApi, id: string) {
  const result = renderConsole(api, `/console/sessions/${id}`);
  await screen.findByRole("tablist", { name: "Session detail" });
  return result;
}

describe("blocking-request panel (W4 step 2, §9.5)", () => {
  it("renders the blocking tool request: tool name + collapsed input", async () => {
    const user = userEvent.setup();
    await renderDetail(fakeRequiresAction(), "sess_01WAIT");
    const panel = await screen.findByRole("group", {
      name: "Blocking requests",
    });

    expect(panel).toHaveTextContent(/Waiting on you/);
    expect(within(panel).getByText("bash")).toBeInTheDocument();
    // DP-2: the input payload is collapsed until asked for.
    const toggle = within(panel).getByRole("button", { name: /input/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(
      within(panel).getByText(/"command": "rm -rf build\/"/),
    ).toBeInTheDocument();
  });

  it("Approve posts user.tool_confirmation {allow} and the panel clears on resumption", async () => {
    const user = userEvent.setup();
    const api = fakeRequiresAction();
    await renderDetail(api, "sess_01WAIT");
    const panel = await screen.findByRole("group", {
      name: "Blocking requests",
    });

    // The confirmation resumes the session server-side; the fake's session
    // flips before the click so the mutation's invalidation-driven refetch
    // (in production also triggered by the §8 stream's status frame)
    // deterministically observes the resumed state.
    const session = api.sessions.find((s) => s.id === "sess_01WAIT")!;
    session.status = "running";
    session.stopReason = null;

    await user.click(within(panel).getByRole("button", { name: "Approve" }));

    expect(api.calls).toContainEqual({
      method: "POST",
      path: "/v1/sessions/sess_01WAIT/events",
      body: {
        type: "user.tool_confirmation",
        eventId: "evt_01BLOCK",
        decision: "allow",
      },
    });
    expect(
      await screen.findByText("Approved — the session resumes"),
    ).toBeInTheDocument();
    // W4 step 2 close: the panel clears once the transition lands.
    await waitFor(() =>
      expect(
        screen.queryByRole("group", { name: "Blocking requests" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("Deny posts user.tool_confirmation {deny}", async () => {
    const user = userEvent.setup();
    const api = fakeRequiresAction();
    await renderDetail(api, "sess_01WAIT");
    const panel = await screen.findByRole("group", {
      name: "Blocking requests",
    });

    await user.click(within(panel).getByRole("button", { name: "Deny" }));

    expect(api.calls).toContainEqual({
      method: "POST",
      path: "/v1/sessions/sess_01WAIT/events",
      body: {
        type: "user.tool_confirmation",
        eventId: "evt_01BLOCK",
        decision: "deny",
      },
    });
    expect(
      await screen.findByText(/Denied — the tool call is rejected/),
    ).toBeInTheDocument();
  });

  it("a blocking id outside the loaded slice is still answerable", async () => {
    const api = fakeRequiresAction();
    // The status_idle entry references an event the 200-entry slice missed.
    api.entries.set("sess_01WAIT", [
      {
        seq: 2,
        type: "session.status_idle",
        processedAt: "2026-07-02T10:00:02.000Z",
        stopReason: "requires_action",
        blockingEventIds: ["evt_01ELSEWHERE"],
      },
    ]);
    await renderDetail(api, "sess_01WAIT");
    const panel = await screen.findByRole("group", {
      name: "Blocking requests",
    });

    expect(within(panel).getByText("evt_01ELSEWHERE")).toBeInTheDocument();
    expect(
      within(panel).getByRole("button", { name: "Approve" }),
    ).toBeEnabled();
  });

  it("read scope: Approve and Deny render disabled with the reason (§6.1, W4 watch-out)", async () => {
    await renderDetail(fakeRequiresAction(["read"]), "sess_01WAIT");
    const panel = await screen.findByRole("group", {
      name: "Blocking requests",
    });

    const approve = within(panel).getByRole("button", { name: "Approve" });
    const deny = within(panel).getByRole("button", { name: "Deny" });
    expect(approve).toBeDisabled();
    expect(deny).toBeDisabled();
    expect(approve).toHaveAccessibleDescription(/requires the write scope/);
    expect(deny).toHaveAccessibleDescription(/requires the write scope/);
  });
});

describe("steering composer (W4 step 3)", () => {
  it("idle + write: Send posts user.message and clears the input", async () => {
    const user = userEvent.setup();
    const api = fakeWithSession("idle");
    await renderDetail(api, "sess_01AAA");

    const input = screen.getByLabelText("Steer this session");
    await user.type(input, "also update the changelog");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(api.calls).toContainEqual({
      method: "POST",
      path: "/v1/sessions/sess_01AAA/events",
      body: { type: "user.message", content: "also update the changelog" },
    });
    expect(
      await screen.findByText("Steering message sent"),
    ).toBeInTheDocument();
    expect(input).toHaveValue("");
  });

  it("an empty draft sends nothing", async () => {
    const user = userEvent.setup();
    const api = fakeWithSession("idle");
    await renderDetail(api, "sess_01AAA");
    const posts = api.calls.filter((c) => c.method === "POST").length;

    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(posts);
  });

  it("mid-turn: Send is disabled with the interrupt-first reason (user.message is idle-only)", async () => {
    await renderDetail(fakeWithSession("running"), "sess_01AAA");
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    expect(send).toHaveAccessibleDescription(
      "session is mid-turn — Interrupt first, then steer",
    );
  });

  it("read scope: composer renders disabled with the reason, not hidden (§6.1)", async () => {
    await renderDetail(fakeWithSession("idle", ["read"]), "sess_01AAA");
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    expect(send).toHaveAccessibleDescription("requires the write scope");
  });

  it("absent on a terminated session (nothing to steer)", async () => {
    const api = FakeConsoleApi.signedIn(["read", "write"]);
    api.addSession({
      id: "sess_01DEAD",
      status: "terminated",
      stopReason: "completed",
    });
    await renderDetail(api, "sess_01DEAD");
    expect(
      screen.queryByLabelText("Steer this session"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Interrupt" }),
    ).not.toBeInTheDocument();
  });
});

describe("interrupt (W4 step 3)", () => {
  it("running + write: confirm-free, posts user.interrupt, acknowledged by toast", async () => {
    const user = userEvent.setup();
    const api = fakeWithSession("running");
    await renderDetail(api, "sess_01AAA");

    await user.click(screen.getByRole("button", { name: "Interrupt" }));

    expect(api.calls).toContainEqual({
      method: "POST",
      path: "/v1/sessions/sess_01AAA/events",
      body: { type: "user.interrupt" },
    });
    expect(
      await screen.findByText(/Interrupt sent — the turn stops/),
    ).toBeInTheDocument();
  });

  it("not rendered while idle (nothing to interrupt)", async () => {
    await renderDetail(fakeWithSession("idle"), "sess_01AAA");
    expect(
      screen.queryByRole("button", { name: "Interrupt" }),
    ).not.toBeInTheDocument();
  });

  it("read scope: disabled with the reason (§6.1)", async () => {
    await renderDetail(fakeWithSession("running", ["read"]), "sess_01AAA");
    const interrupt = screen.getByRole("button", { name: "Interrupt" });
    expect(interrupt).toBeDisabled();
    expect(interrupt).toHaveAccessibleDescription(/requires the write scope/);
  });
});

describe("failure rendering (DP-9)", () => {
  it("a rejected event post renders the error facts inline", async () => {
    const user = userEvent.setup();
    const api = fakeRequiresAction();
    await renderDetail(api, "sess_01WAIT");
    const panel = await screen.findByRole("group", {
      name: "Blocking requests",
    });

    // The session vanishes server-side after render: the POST answers a
    // real-shaped 404 envelope.
    api.sessions = [];
    await user.click(within(panel).getByRole("button", { name: "Approve" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("not_found");
    expect(alert).toHaveTextContent("req_01TESTREQUEST");
  });
});

describe("accessibility", () => {
  it("blocking panel + composer are axe-clean (write scope)", async () => {
    const { view } = await renderDetail(fakeRequiresAction(), "sess_01WAIT");
    await screen.findByRole("group", { name: "Blocking requests" });
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it("disabled-with-reason controls are axe-clean (read scope, running)", async () => {
    const { view } = await renderDetail(
      fakeWithSession("running", ["read"]),
      "sess_01AAA",
    );
    await screen.findByRole("button", { name: "Interrupt" });
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
