/**
 * Phase-1 gate — console-spec §13 item §6.1: each scope sees exactly its
 * surfaces. Gate-level pin of the scope matrix (§6.1–§6.3, §7.1) that
 * `src/app/shell.test.tsx` covers during development: the sidebar section
 * set per scope is EXACT (extra or missing sections fail), `read` is badged
 * read-only, `admin` gets the least-privilege nudge. Hiding is presentation
 * only — the backend stays the enforcer (§6.4) — so this gate is about what
 * each scope is SHOWN.
 *
 * The API client is a collaborator (fake at the `<ApiClientProvider>` seam);
 * the rendered app tree is the real one.
 */
import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { FakeConsoleApi } from "../../src/test/fake-console-api.js";
import { renderConsole } from "../../src/test/render-console.js";
import "../../src/ui/test-utils.js"; // afterEach(cleanup)

const BROWSING_SECTIONS = ["Home", "Sessions", "Agents", "Jobs", "Resources"];
const ALL_SECTIONS = [...BROWSING_SECTIONS, "Settings"];

async function renderShell(scopes: string[]): Promise<string[]> {
  renderConsole(FakeConsoleApi.signedIn(scopes));
  const nav = await screen.findByRole("navigation", { name: "Primary" });
  return within(nav)
    .getAllByRole("link")
    .map((link) => link.textContent ?? "");
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("§6.1 — scope matrix: each scope sees exactly its surfaces", () => {
  it("read: browsing sections only + read-only badge, no Settings, no nudge", async () => {
    expect(await renderShell(["read"])).toEqual(BROWSING_SECTIONS);
    expect(screen.getByText("browsing read-only")).toBeInTheDocument();
    expect(screen.queryByText(/admin-scoped key/)).not.toBeInTheDocument();
  });

  it("read+write: same sections (write adds actions, not sections), no badge", async () => {
    expect(await renderShell(["read", "write"])).toEqual(BROWSING_SECTIONS);
    expect(screen.queryByText("browsing read-only")).not.toBeInTheDocument();
    expect(screen.queryByText(/admin-scoped key/)).not.toBeInTheDocument();
  });

  it("admin: all §7.1 sections + one-time least-privilege nudge, no badge", async () => {
    expect(await renderShell(["admin"])).toEqual(ALL_SECTIONS);
    expect(screen.queryByText("browsing read-only")).not.toBeInTheDocument();
    expect(screen.getByText(/admin-scoped key/)).toBeInTheDocument();
  });
});
