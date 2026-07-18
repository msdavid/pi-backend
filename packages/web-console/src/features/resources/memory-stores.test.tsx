/**
 * Memory stores feature tests (WP-C2.4; console-spec §9.5 read surface):
 * list, store detail with per-memory content viewing (JSON → JsonViewer,
 * plain text → verbatim), and the version audit trail with per-version view
 * plus restore (WP-C4.0b: write-scoped, disabled-with-reason, plain confirm
 * dialog, success toast + auto-opened new head). The API client is a
 * collaborator (fake at the `<ApiClientProvider>` seam).
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeConsoleApi } from "../../test/fake-console-api.js";
import { renderConsole } from "../../test/render-console.js";
import { axe } from "../../ui/test-utils.js";

beforeEach(() => {
  window.localStorage.clear();
});

function fakeWithStore(scopes: string[] = ["read"]): FakeConsoleApi {
  const api = FakeConsoleApi.signedIn(scopes);
  api.addMemoryStore({
    id: "mem_01CONVENTIONS",
    displayTitle: "Project conventions",
    instructions: "Follow the existing patterns.",
  });
  api.addMemory("mem_01CONVENTIONS", {
    path: "conventions.md",
    content: "Use absolute imports.",
  });
  api.addMemory("mem_01CONVENTIONS", {
    path: "state.json",
    content: '{"phase": 2, "done": false}',
  });
  api.addMemoryVersion("mem_01CONVENTIONS", {
    id: "memver_01NEWEST",
    memoryPath: "conventions.md",
    createdAt: "2026-07-02T00:00:00.000Z",
  });
  api.addMemoryVersion("mem_01CONVENTIONS", {
    id: "memver_01REDACTED",
    memoryPath: "secrets.md",
    redacted: true,
    createdAt: "2026-07-03T00:00:00.000Z",
  });
  return api;
}

describe("memory stores list (§9.5)", () => {
  it("renders title, id, access, status, and updated columns", async () => {
    renderConsole(fakeWithStore(), "/console/resources/memory-stores");
    const table = await screen.findByRole("table", { name: "Memory stores" });

    const headers = within(table)
      .getAllByRole("columnheader")
      .map((th) => th.textContent);
    expect(headers).toEqual(["Title", "ID", "Access", "Status", "Updated"]);

    const row = within(table).getAllByRole("row")[1]!;
    expect(within(row).getByText("Project conventions")).toBeInTheDocument();
    expect(within(row).getByTitle("mem_01CONVENTIONS")).toBeInTheDocument();
    expect(within(row).getByText("read_write")).toBeInTheDocument();
    expect(within(row).getByText("active")).toBeInTheDocument();
  });

  it("row activation navigates to the store detail route", async () => {
    const user = userEvent.setup();
    const { router } = renderConsole(
      fakeWithStore(),
      "/console/resources/memory-stores",
    );
    const table = await screen.findByRole("table", { name: "Memory stores" });
    await user.click(within(table).getByText("Project conventions"));
    expect(router.state.location.pathname).toBe(
      "/resources/memory-stores/mem_01CONVENTIONS",
    );
  });

  it("teaching empty state carries the CLI command (DP-5)", async () => {
    renderConsole(
      FakeConsoleApi.signedIn(["read"]),
      "/console/resources/memory-stores",
    );
    expect(
      await screen.findByText("No memory stores yet"),
    ).toBeInTheDocument();
    expect(screen.getByText("/remote:memory")).toBeInTheDocument();
  });
});

describe("memory store detail (§9.5)", () => {
  const DETAIL = "/console/resources/memory-stores/mem_01CONVENTIONS";

  it("leads with the store facts and instructions", async () => {
    renderConsole(fakeWithStore(), DETAIL);
    expect(
      await screen.findByRole("heading", { name: "Project conventions" }),
    ).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("read_write")).toBeInTheDocument();
    expect(
      screen.getByText("Follow the existing patterns."),
    ).toBeInTheDocument();
  });

  it("opens a plain-text memory verbatim (content fetched on demand, DP-2)", async () => {
    const user = userEvent.setup();
    const api = fakeWithStore();
    renderConsole(api, DETAIL);
    const table = await screen.findByRole("table", { name: "Memories" });

    // No content request until a memory is opened.
    expect(
      api.calls.some((c) => c.path.includes("/memories/")),
    ).toBe(false);

    await user.click(within(table).getByText("conventions.md"));
    expect(
      await screen.findByText("Use absolute imports."),
    ).toBeInTheDocument();
    expect(
      api.calls.some(
        (c) =>
          c.method === "GET" &&
          c.path ===
            "/v1/memory-stores/mem_01CONVENTIONS/memories/conventions.md",
      ),
    ).toBe(true);
  });

  it("renders a JSON memory in the JsonViewer", async () => {
    const user = userEvent.setup();
    renderConsole(fakeWithStore(), DETAIL);
    const table = await screen.findByRole("table", { name: "Memories" });

    await user.click(within(table).getByText("state.json"));
    // The JsonViewer toggle (collapsed by default) is the JSON rendering.
    const toggle = await screen.findByRole("button", { name: /state\.json/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(screen.getByText(/"phase": 2/)).toBeInTheDocument();
  });

  it("lists the version audit trail and opens a version (plan deliverable)", async () => {
    const user = userEvent.setup();
    renderConsole(fakeWithStore(), DETAIL);
    await screen.findByRole("table", { name: "Memories" });

    await user.click(screen.getByRole("tab", { name: "Version history" }));
    const table = await screen.findByRole("table", { name: "Memory versions" });

    // Newest first; the redacted version is flagged.
    const [redacted, newest] = within(table).getAllByRole("row").slice(1);
    expect(within(redacted!).getByText("memver_01REDACTED")).toBeInTheDocument();
    expect(within(redacted!).getByText("yes")).toBeInTheDocument();
    expect(within(newest!).getByText("memver_01NEWEST")).toBeInTheDocument();

    await user.click(within(newest!).getByText("memver_01NEWEST"));
    const panel = await screen.findByLabelText("Version memver_01NEWEST");
    expect(within(panel).getByText("conventions.md")).toBeInTheDocument();
    expect(within(panel).getByText("b".repeat(64))).toBeInTheDocument();
  });

  it("the version-history copy states what restore really does (WP-C4.0b — the audit-only claim is gone)", async () => {
    const user = userEvent.setup();
    renderConsole(fakeWithStore(), DETAIL);
    await screen.findByRole("table", { name: "Memories" });

    await user.click(screen.getByRole("tab", { name: "Version history" }));
    await screen.findByRole("table", { name: "Memory versions" });
    expect(
      screen.getByText(
        /Restore copies a version's content into a new head version/,
      ),
    ).toBeInTheDocument();
    // The pre-WP-C4.0 claims must never come back: restore exists now.
    expect(document.body.textContent).not.toContain(
      "cannot be restored from here",
    );
    expect(document.body.textContent).not.toContain(
      "Restore lands with the phase-3 admin surface",
    );
  });

  it("is axe-clean", async () => {
    const { view } = renderConsole(fakeWithStore(), DETAIL);
    await screen.findByRole("table", { name: "Memories" });
    expect(await axe(view.container)).toHaveNoViolations();
  });
});

describe("memory version restore (§9.5, WP-C4.0b)", () => {
  const DETAIL = "/console/resources/memory-stores/mem_01CONVENTIONS";

  /** Renders the detail and opens the Version history tab. */
  async function openVersions(
    user: ReturnType<typeof userEvent.setup>,
    api: FakeConsoleApi,
  ) {
    const rendered = renderConsole(api, DETAIL);
    await screen.findByRole("table", { name: "Memories" });
    await user.click(screen.getByRole("tab", { name: "Version history" }));
    await screen.findByRole("table", { name: "Memory versions" });
    return rendered;
  }

  it("write scope: Restore enabled on intact versions; disabled on redacted ones WITH the reason", async () => {
    const user = userEvent.setup();
    await openVersions(user, fakeWithStore(["read", "write"]));

    // Rows are newest first: [redacted, intact].
    const [redacted, intact] = screen.getAllByRole("button", {
      name: "Restore",
    });
    expect(redacted).toBeDisabled();
    expect(redacted).toHaveAttribute(
      "aria-describedby",
      "memory-restore-redacted-note",
    );
    expect(
      screen.getByText(/Redacted versions cannot be restored/),
    ).toBeInTheDocument();
    expect(intact).toBeEnabled();
  });

  it("read scope: every Restore is disabled with the scope reason (§6.1)", async () => {
    const user = userEvent.setup();
    await openVersions(user, fakeWithStore(["read"]));

    for (const button of screen.getAllByRole("button", { name: "Restore" })) {
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute(
        "aria-describedby",
        "memory-restore-scope-note",
      );
    }
    expect(
      screen.getByText("Restore requires the write scope."),
    ).toBeInTheDocument();
  });

  it("restore flow: NEW-version confirm dialog → POST → toast → new head listed, opened, and scrolled to", async () => {
    const scrollIntoView = vi.fn();
    // jsdom implements no scrolling; the DOM API is a collaborator here.
    Element.prototype.scrollIntoView = scrollIntoView;

    const user = userEvent.setup();
    const api = fakeWithStore(["read", "write"]);
    await openVersions(user, api);

    const [, intact] = screen.getAllByRole("button", { name: "Restore" });
    await user.click(intact!);

    // Plain, non-destructive Dialog (not TypedConfirm — no typed gate) that
    // says a NEW version is created and nothing is rewritten.
    const dialog = await screen.findByRole("dialog", {
      name: "Restore version",
    });
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    expect(dialog.textContent).toContain("NEW version");
    expect(dialog.textContent).toContain("Nothing is deleted or rewritten");
    // Clicking the button did NOT also toggle the row's version panel.
    expect(screen.queryByLabelText("Version memver_01NEWEST")).toBeNull();

    await user.click(within(dialog).getByRole("button", { name: "Restore" }));

    expect(
      api.calls.some(
        (c) =>
          c.method === "POST" &&
          c.path ===
            "/v1/memory-stores/mem_01CONVENTIONS/versions/memver_01NEWEST/restore",
      ),
    ).toBe(true);

    // Success toast names the new head; the invalidated list refetch
    // surfaces it as the newest-first head; its panel opens and scrolls.
    expect(
      await screen.findByText(
        "Restored conventions.md — new head version memver_01RESTORED",
      ),
    ).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Memory versions" });
    const head = within(table).getAllByRole("row")[1]!;
    expect(within(head).getByText("memver_01RESTORED")).toBeInTheDocument();
    const panel = await screen.findByLabelText("Version memver_01RESTORED");
    expect(within(panel).getByText("b".repeat(64))).toBeInTheDocument();
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("restore conflict: a 409 on an intact version surfaces the ErrorAlert (F7)", async () => {
    const user = userEvent.setup();
    const api = fakeWithStore(["read", "write"]);
    // An intact version whose restore nonetheless conflicts (tombstone) — the
    // reachable 409 the ErrorAlert handles. Redacted versions can't reach it
    // (their Restore button is disabled), so it needs a designated intact one.
    api.restoreConflictVersionId = "memver_01NEWEST";
    await openVersions(user, api);

    const [, intact] = screen.getAllByRole("button", { name: "Restore" });
    await user.click(intact!);
    const dialog = await screen.findByRole("dialog", {
      name: "Restore version",
    });
    await user.click(within(dialog).getByRole("button", { name: "Restore" }));

    // The dialog stays open and shows the error; no success toast fires.
    expect(
      await within(dialog).findByText(
        /conflicts with the current memory state/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/new head version memver_01RESTORED/),
    ).toBeNull();
    // The restore POST was attempted (the reachable path was exercised).
    expect(
      api.calls.some(
        (c) =>
          c.method === "POST" &&
          c.path ===
            "/v1/memory-stores/mem_01CONVENTIONS/versions/memver_01NEWEST/restore",
      ),
    ).toBe(true);
  });

  it("is axe-clean with the restore controls and the open dialog", async () => {
    const user = userEvent.setup();
    const { view } = await openVersions(user, fakeWithStore(["read", "write"]));
    expect(await axe(view.container)).toHaveNoViolations();

    const [, intact] = screen.getAllByRole("button", { name: "Restore" });
    await user.click(intact!);
    await screen.findByRole("dialog", { name: "Restore version" });
    // The dialog portals into document.body, outside the view container.
    expect(await axe(document.body)).toHaveNoViolations();
  });

  afterEach(() => {
    // @ts-expect-error restore jsdom's (absent) implementation
    delete Element.prototype.scrollIntoView;
  });
});
