/**
 * Files + skills feature tests (WP-C3.6; console-spec §9.5 remainder):
 * list columns, on-demand detail panels (DP-2), the same-origin content
 * download anchor, DP-7 typed-confirmation hard deletes gated on the write
 * scope (disabled-with-reason otherwise, C§6.1), the `?type=` skills filter,
 * and the DP-5 teaching empty states (uploads are API-only multipart).
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

const FILES = "/console/resources/files";
const SKILLS = "/console/resources/skills";

function fakeWithFiles(scopes: string[]): FakeConsoleApi {
  const api = FakeConsoleApi.signedIn(scopes);
  api.addFile({
    id: "file_01REPORT",
    name: "report.pdf",
    sizeBytes: 1024,
    sessionId: "sess_01OWNER",
  });
  api.addFile({
    id: "file_01NOTES",
    name: "notes.txt",
    contentType: "text/plain",
    sizeBytes: 10,
  });
  return api;
}

function fakeWithSkills(scopes: string[]): FakeConsoleApi {
  const api = FakeConsoleApi.signedIn(scopes);
  api.addSkill({
    id: "skill_01PDF",
    displayTitle: "PDF toolkit",
    versions: [
      { version: 1, createdAt: "2026-07-01T00:00:00.000Z" },
      { version: 2, createdAt: "2026-07-02T00:00:00.000Z" },
    ],
  });
  api.addSkill({
    id: "skill_01XLSX",
    displayTitle: "Spreadsheets",
    type: "prebuilt",
  });
  return api;
}

describe("files (§9.5)", () => {
  it("lists name, id, type, size, session link, created", async () => {
    renderConsole(fakeWithFiles(["read"]), FILES);
    const table = await screen.findByRole("table", { name: "Files" });

    const headers = within(table)
      .getAllByRole("columnheader")
      .map((th) => th.textContent);
    expect(headers).toEqual([
      "Name",
      "ID",
      "Content type",
      "Size",
      "Session",
      "Created",
    ]);

    const row = within(table).getByText("report.pdf").closest("tr")!;
    expect(within(row).getByTitle("file_01REPORT")).toBeInTheDocument();
    expect(within(row).getByText("1.0 KiB")).toBeInTheDocument();
    // §7.6: the session id deep-links to its detail route.
    expect(
      within(row).getByRole("link", { name: /sess_01OWNER/ }),
    ).toHaveAttribute("href", "/console/sessions/sess_01OWNER");
  });

  it("row activation opens the detail panel with the content download anchor", async () => {
    const user = userEvent.setup();
    const api = fakeWithFiles(["read"]);
    renderConsole(api, FILES);
    const table = await screen.findByRole("table", { name: "Files" });

    await user.click(within(table).getByText("report.pdf"));
    const panel = await screen.findByLabelText("File file_01REPORT");
    // Detail is fetched on open (DP-2)…
    expect(
      api.calls.some(
        (c) => c.method === "GET" && c.path === "/v1/files/file_01REPORT",
      ),
    ).toBe(true);
    // …and content is a plain same-origin anchor (cookie rides the GET).
    const download = await within(panel).findByRole("link", {
      name: "Download content",
    });
    expect(download).toHaveAttribute("href", "/v1/files/file_01REPORT/content");
    expect(download).toHaveAttribute("download", "report.pdf");
  });

  it("hard-deletes behind a DP-7 typed confirmation (write scope)", async () => {
    const user = userEvent.setup();
    const api = fakeWithFiles(["write"]);
    renderConsole(api, FILES);
    const table = await screen.findByRole("table", { name: "Files" });

    await user.click(within(table).getByText("report.pdf"));
    const panel = await screen.findByLabelText("File file_01REPORT");
    await user.click(
      await within(panel).findByRole("button", { name: "Delete" }),
    );

    const dialog = await screen.findByRole("dialog", { name: "Delete file" });
    expect(
      within(dialog).getByText(/permanently deletes "report\.pdf"/),
    ).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", {
      name: "Delete file",
    });
    expect(confirm).toBeDisabled();
    await user.type(
      within(dialog).getByLabelText('Type "report.pdf" to confirm'),
      "report.pdf",
    );
    await user.click(confirm);

    await waitFor(() =>
      expect(
        api.calls.some(
          (c) => c.method === "DELETE" && c.path === "/v1/files/file_01REPORT",
        ),
      ).toBe(true),
    );
    // The list refetches and the row is gone.
    await waitFor(() =>
      expect(screen.queryByText("report.pdf")).not.toBeInTheDocument(),
    );
  });

  it("read-only keys see delete disabled with the reason (C§6.1)", async () => {
    const user = userEvent.setup();
    renderConsole(fakeWithFiles(["read"]), FILES);
    const table = await screen.findByRole("table", { name: "Files" });

    await user.click(within(table).getByText("notes.txt"));
    const panel = await screen.findByLabelText("File file_01NOTES");
    expect(
      await within(panel).findByRole("button", { name: "Delete" }),
    ).toBeDisabled();
    expect(
      within(panel).getByText("requires the write scope"),
    ).toBeInTheDocument();
  });

  it("teaching empty state names the multipart upload path (DP-5)", async () => {
    renderConsole(FakeConsoleApi.signedIn(["read"]), FILES);
    expect(await screen.findByText("No files yet")).toBeInTheDocument();
    // A WORKING command: uploads hard-require bearer AND Idempotency-Key.
    const taught = screen.getByText(/curl -X POST \$PI_BACKEND_URL\/v1\/files/);
    expect(taught.textContent).toContain("Authorization: Bearer");
    expect(taught.textContent).toContain("Idempotency-Key:");
  });

  it("is axe-clean with the detail panel open", async () => {
    const user = userEvent.setup();
    const { view } = renderConsole(fakeWithFiles(["admin"]), FILES);
    const table = await screen.findByRole("table", { name: "Files" });
    await user.click(within(table).getByText("report.pdf"));
    await screen.findByLabelText("File file_01REPORT");
    expect(await axe(view.container)).toHaveNoViolations();
  });
});

describe("skills (§9.5)", () => {
  it("lists skills and narrows by ?type= server-side", async () => {
    const user = userEvent.setup();
    const api = fakeWithSkills(["read"]);
    renderConsole(api, SKILLS);
    const table = await screen.findByRole("table", { name: "Skills" });
    expect(within(table).getByText("PDF toolkit")).toBeInTheDocument();
    expect(within(table).getByText("Spreadsheets")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Type"), "custom");
    await waitFor(() =>
      expect(
        api.calls.some(
          (c) => c.method === "GET" && c.path === "/v1/skills?type=custom",
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(screen.queryByText("Spreadsheets")).not.toBeInTheDocument(),
    );
  });

  it("row activation opens the panel with the version history", async () => {
    const user = userEvent.setup();
    const api = fakeWithSkills(["read"]);
    renderConsole(api, SKILLS);
    const table = await screen.findByRole("table", { name: "Skills" });

    await user.click(within(table).getByText("PDF toolkit"));
    const versions = await screen.findByRole("table", {
      name: "Skill versions",
    });
    expect(within(versions).getByText("v1")).toBeInTheDocument();
    expect(within(versions).getByText("v2")).toBeInTheDocument();
    expect(
      api.calls.some(
        (c) => c.method === "GET" && c.path === "/v1/skills/skill_01PDF/versions",
      ),
    ).toBe(true);
  });

  it("hard-deletes behind a DP-7 typed confirmation naming the version count", async () => {
    const user = userEvent.setup();
    const api = fakeWithSkills(["admin"]);
    renderConsole(api, SKILLS);
    const table = await screen.findByRole("table", { name: "Skills" });

    await user.click(within(table).getByText("PDF toolkit"));
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete skill" });
    expect(
      within(dialog).getByText(/all 2 uploaded version\(s\)/),
    ).toBeInTheDocument();
    await user.type(
      within(dialog).getByLabelText('Type "PDF toolkit" to confirm'),
      "PDF toolkit",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Delete skill" }),
    );

    await waitFor(() =>
      expect(
        api.calls.some(
          (c) => c.method === "DELETE" && c.path === "/v1/skills/skill_01PDF",
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(screen.queryByText("PDF toolkit")).not.toBeInTheDocument(),
    );
  });

  it("teaching empty state names the multipart upload path (DP-5)", async () => {
    renderConsole(FakeConsoleApi.signedIn(["read"]), SKILLS);
    expect(await screen.findByText("No skills here yet")).toBeInTheDocument();
    // A WORKING command: uploads hard-require bearer AND Idempotency-Key.
    const taught = screen.getByText(/curl -X POST \$PI_BACKEND_URL\/v1\/skills/);
    expect(taught.textContent).toContain("Authorization: Bearer");
    expect(taught.textContent).toContain("Idempotency-Key:");
  });

  it("is axe-clean with the panel open", async () => {
    const user = userEvent.setup();
    const { view } = renderConsole(fakeWithSkills(["read"]), SKILLS);
    const table = await screen.findByRole("table", { name: "Skills" });
    await user.click(within(table).getByText("PDF toolkit"));
    await screen.findByRole("table", { name: "Skill versions" });
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
