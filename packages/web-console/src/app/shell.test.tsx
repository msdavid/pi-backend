/**
 * Scope-variant shell (WP-C1.6 + WP-C2.2; console-spec §6.1–§6.3, §7.1,
 * §7.5; conformance §13 "scope matrix"): each scope sees exactly its sidebar
 * surfaces, `read` is badged, `admin` gets the one-time least-privilege
 * nudge, and the Sessions nav item carries the requires_action count badge.
 */
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { ambientFavicon } from "../lib/ambient-status.js";
import { FakeConsoleApi } from "../test/fake-console-api.js";
import { renderConsole } from "../test/render-console.js";
import { axe } from "../ui/test-utils.js";

async function renderShell(scopes: string[]) {
  const result = renderConsole(FakeConsoleApi.signedIn(scopes));
  // The shell is up once the primary navigation is on screen.
  const nav = await screen.findByRole("navigation", { name: "Primary" });
  return { ...result, nav };
}

function navLabels(nav: HTMLElement): string[] {
  return within(nav)
    .getAllByRole("link")
    .map((link) => link.textContent ?? "");
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("AppShell scope matrix (console-spec §13 item 6.1)", () => {
  it("read: browsing sections only, Settings hidden, read-only badge shown", async () => {
    const { nav } = await renderShell(["read"]);
    expect(navLabels(nav)).toEqual([
      "Home",
      "Sessions",
      "Agents",
      "Jobs",
      "Resources",
    ]);
    expect(screen.getByText("browsing read-only")).toBeInTheDocument();
    expect(
      screen.queryByText(/admin-scoped key/, { exact: false }),
    ).not.toBeInTheDocument();
  });

  it("read+write: same sections (write adds actions, not sections), no badge", async () => {
    const { nav } = await renderShell(["read", "write"]);
    expect(navLabels(nav)).toEqual([
      "Home",
      "Sessions",
      "Agents",
      "Jobs",
      "Resources",
    ]);
    expect(screen.queryByText("browsing read-only")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/admin-scoped key/, { exact: false }),
    ).not.toBeInTheDocument();
  });

  it("admin: all six §7.1 sections, least-privilege nudge, no badge", async () => {
    const { nav } = await renderShell(["admin"]);
    expect(navLabels(nav)).toEqual([
      "Home",
      "Sessions",
      "Agents",
      "Jobs",
      "Resources",
      "Settings",
    ]);
    expect(screen.queryByText("browsing read-only")).not.toBeInTheDocument();
    expect(screen.getByText(/admin-scoped key/)).toBeInTheDocument();
  });
});

describe("AppShell session summary (W1)", () => {
  it("shows the tenant name and the key's scopes", async () => {
    await renderShell(["read", "write"]);
    expect(screen.getByText("Acme Corp")).toBeInTheDocument();
    expect(screen.getByText("key scopes: read, write")).toBeInTheDocument();
  });
});

describe("admin least-privilege nudge (console-spec §6.3, DP-8)", () => {
  it("dismisses one-time: persisted per-browser, absent on the next mount", async () => {
    const user = userEvent.setup();
    const { view } = await renderShell(["admin"]);
    await user.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByText(/admin-scoped key/)).not.toBeInTheDocument();
    expect(
      window.localStorage.getItem("pi-console.admin-nudge-dismissed"),
    ).toBe("1");

    // A fresh mount (new visit, same browser) stays dismissed.
    view.unmount();
    await renderShell(["admin"]);
    expect(screen.queryByText(/admin-scoped key/)).not.toBeInTheDocument();
  });
});

describe("requires_action sidebar badge (WP-C2.2; console-spec §7.5)", () => {
  it("shows the count on the Sessions item, via the server-side filter", async () => {
    const api = FakeConsoleApi.signedIn(["read"]);
    api.addSession({
      id: "sess_01WAIT1",
      status: "idle",
      stopReason: "requires_action",
    });
    api.addSession({
      id: "sess_01WAIT2",
      status: "idle",
      stopReason: "requires_action",
      createdAt: "2026-07-02T00:00:00.000Z",
    });
    api.addSession({ id: "sess_01RUN", status: "running" });
    renderConsole(api);
    const nav = await screen.findByRole("navigation", { name: "Primary" });

    const sessionsLink = await within(nav).findByRole("link", {
      // Whitespace between the label, the count and the screen-reader unit
      // is markup-dependent — match the parts, not one exact string.
      name: (name) =>
        /Sessions/.test(name) && /2\s*sessions require action/.test(name),
    });
    expect(sessionsLink).toHaveAttribute("href", "/console/sessions");
    // Powered by the WP-C2.0 stopReason filter — no client-side scanning.
    expect(
      api.calls.some(
        (c) =>
          c.method === "GET" && c.path.includes("stopReason=requires_action"),
      ),
    ).toBe(true);
  });

  it("is absent while nothing requires action", async () => {
    const { nav } = await renderShell(["read"]);
    await waitFor(() =>
      expect(
        within(nav).getByRole("link", { name: "Sessions" }),
      ).toBeInTheDocument(),
    );
    expect(
      within(nav).queryByText(/require action/),
    ).not.toBeInTheDocument();
  });
});

describe("ambient status (WP-C2.5; console-spec §8.3, DP-11)", () => {
  it("mirrors the viewed session's status into title + favicon, restores on leave", async () => {
    document.title = "Pi Console";
    const api = FakeConsoleApi.signedIn(["read"]);
    api.addSession({ id: "sess_01AMBIENT", status: "running" });

    const { router, view } = renderConsole(
      api,
      "/console/sessions/sess_01AMBIENT",
    );
    await waitFor(() =>
      expect(document.title).toBe("running — Pi Console"),
    );
    expect(
      document.querySelector('link[rel="icon"]')?.getAttribute("href"),
    ).toBe(ambientFavicon("running"));

    // Leaving the session route puts the page defaults back.
    await router.navigate({ to: "/" });
    await waitFor(() => expect(document.title).toBe("Pi Console"));
    expect(document.querySelector('link[rel="icon"]')).toBeNull();
    view.unmount();
  });

  it("stays fresh while a non-Trace tab is active (the detail page owns the stream, §8.3)", async () => {
    document.title = "Pi Console";
    const user = userEvent.setup();
    const api = FakeConsoleApi.signedIn(["read"]);
    api.addSession({ id: "sess_01AMBIENT", status: "running" });

    const { view } = renderConsole(api, "/console/sessions/sess_01AMBIENT");
    await waitFor(() => expect(document.title).toBe("running — Pi Console"));
    await user.click(await screen.findByRole("tab", { name: "Usage" }));

    // The turn finishes while the Usage tab is up: the wire session now
    // reads idle/completed and the stream announces it — the ambient badge
    // must follow even though the Trace tab (and only it) is unmounted.
    api.sessions[0] = {
      ...api.sessions[0]!,
      status: "idle",
      stopReason: "completed",
    };
    act(() => {
      api.emitStream("sess_01AMBIENT", {
        id: 0,
        event: "session.status_idle",
        data: {
          type: "session.status_idle",
          processedAt: null,
          stopReason: "completed",
        },
      });
    });

    await waitFor(() => expect(document.title).toBe("completed — Pi Console"));
    expect(
      document.querySelector('link[rel="icon"]')?.getAttribute("href"),
    ).toBe(ambientFavicon("completed"));
    view.unmount();
  });

  it("keeps the page defaults for a session without an ambient state", async () => {
    document.title = "Pi Console";
    const api = FakeConsoleApi.signedIn(["read"]);
    api.addSession({ id: "sess_01IDLE", status: "idle" });

    const { view } = renderConsole(api, "/console/sessions/sess_01IDLE");
    await screen.findByRole("heading", { name: /sess_01IDLE/ });
    expect(document.title).toBe("Pi Console");
    expect(document.querySelector('link[rel="icon"]')).toBeNull();
    view.unmount();
  });
});

describe("phone-width drawer (WP-C4.3; console-spec §10.5)", () => {
  // Whether the toggle is VISIBLE is pure CSS (`shell.module.css` media
  // query — jsdom applies no layout); what is assertable here is the
  // disclosure contract the CSS keys off: aria-expanded state wired to the
  // drawer's class, keyboard operability, and closing on navigation.
  it("Menu toggles the drawer disclosure and a nav click closes it", async () => {
    const user = userEvent.setup();
    await renderShell(["read"]);
    const toggle = screen.getByRole("button", { name: "Menu" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls", "shell-drawer");

    // Keyboard-operable: focus + Enter (a real <button>).
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById("shell-drawer")?.className).toMatch(
      /drawerOpen/,
    );

    // Following a nav link closes the drawer (the phone exit path).
    await user.click(screen.getByRole("link", { name: /Sessions/ }));
    await waitFor(() =>
      expect(toggle).toHaveAttribute("aria-expanded", "false"),
    );
  });
});

describe("accessibility", () => {
  it("axe-clean for the signed-in shell", async () => {
    const { view } = await renderShell(["admin"]);
    await screen.findByRole("heading", { name: "Home" });
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it("axe-clean with the drawer disclosure open", async () => {
    const user = userEvent.setup();
    const { view } = await renderShell(["read"]);
    await user.click(screen.getByRole("button", { name: "Menu" }));
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
