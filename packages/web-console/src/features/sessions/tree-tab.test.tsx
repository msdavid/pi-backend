/**
 * Tree tab feature tests (WP-C2.3; console-spec §7.3, W2 step 4). Fork
 * lineage from session resources (every node a SessionId deep link, the
 * viewed session highlighted), the JSONL log tree from `GET …/tree` with
 * fork points marked, and the raw-JSON fallback for a shape the renderer
 * does not know (contracts pins the tree as opaque). The API client is a
 * collaborator (fake at the `<ApiClientProvider>` seam).
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

/** A three-generation fork chain (root → mid → current) plus one child. */
function fakeWithLineage(): FakeConsoleApi {
  const api = FakeConsoleApi.signedIn(["read"]);
  api.addSession({ id: "sess_01ROOT", title: "original run" });
  api.addSession({ id: "sess_01MID", forkedFromSessionId: "sess_01ROOT" });
  api.addSession({
    id: "sess_01CUR",
    title: "the branch under view",
    forkedFromSessionId: "sess_01MID",
  });
  api.addSession({ id: "sess_01KID", forkedFromSessionId: "sess_01CUR" });
  return api;
}

async function renderTreeTab(api: FakeConsoleApi, id = "sess_01CUR") {
  const result = renderConsole(api, `/console/sessions/${id}`);
  await screen.findByRole("tablist", { name: "Session detail" });
  await userEvent.setup().click(screen.getByRole("tab", { name: "Tree" }));
  return result;
}

describe("fork lineage (session-level, §7.6 deep links)", () => {
  it("renders the full ancestor chain and children, all as session links", async () => {
    await renderTreeTab(fakeWithLineage());
    const lineage = await screen.findByRole("list", { name: "Fork lineage" });

    for (const id of ["sess_01ROOT", "sess_01MID", "sess_01CUR", "sess_01KID"]) {
      expect(
        await within(lineage).findByRole("link", { name: new RegExp(id) }),
      ).toHaveAttribute("href", `/console/sessions/${id}`);
    }
  });

  it("highlights the viewed session", async () => {
    await renderTreeTab(fakeWithLineage());
    const lineage = await screen.findByRole("list", { name: "Fork lineage" });
    const current = within(lineage).getByText("this session").parentElement;
    expect(current).toHaveAttribute("aria-current", "true");
    expect(current).toHaveTextContent("sess_01CUR");
  });

  it("a session with no fork relations says so plainly", async () => {
    const api = FakeConsoleApi.signedIn(["read"]);
    api.addSession({ id: "sess_01LONE" });
    await renderTreeTab(api, "sess_01LONE");
    expect(
      await screen.findByText(/Not forked from any session/),
    ).toBeInTheDocument();
  });
});

describe("log tree (GET …/tree)", () => {
  it("renders branches with entry types, ids, and fork points marked", async () => {
    const api = fakeWithLineage();
    api.trees.set("sess_01CUR", {
      root: "e1",
      branches: [
        { id: "e1", parentId: null, type: "user.message" },
        { id: "e2", parentId: "e1", type: "agent.message" },
        { id: "e3", parentId: "e1", type: "agent.message" },
        { id: "e4", parentId: "e3", type: "session.status_idle" },
      ],
    });
    await renderTreeTab(api);

    const tree = await screen.findByRole("list", { name: "Log tree" });
    const items = within(tree).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent("user.message");
    expect(items[0]).toHaveTextContent("e1");
    // e1 has two descendants → fork point.
    expect(items[0]).toHaveTextContent("fork point ×2");
    expect(items[1]).not.toHaveTextContent("fork point");
    expect(items[3]).toHaveTextContent("session.status_idle");
  });

  it("an empty tree explains itself", async () => {
    await renderTreeTab(fakeWithLineage());
    expect(await screen.findByText(/No log entries yet/)).toBeInTheDocument();
  });

  it("an unknown tree shape falls back to the raw JSON viewer", async () => {
    const user = userEvent.setup();
    const api = fakeWithLineage();
    api.trees.set("sess_01CUR", { unforeseen: { shape: true } });
    await renderTreeTab(api);

    const toggle = await screen.findByRole("button", { name: /tree/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(screen.getByText(/"unforeseen"/)).toBeInTheDocument();
  });
});

describe("accessibility", () => {
  it("is axe-clean", async () => {
    const api = fakeWithLineage();
    api.trees.set("sess_01CUR", {
      root: "e1",
      branches: [
        { id: "e1", parentId: null, type: "user.message" },
        { id: "e2", parentId: "e1", type: "agent.message" },
      ],
    });
    const { view } = await renderTreeTab(api);
    await screen.findByRole("list", { name: "Log tree" });
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
