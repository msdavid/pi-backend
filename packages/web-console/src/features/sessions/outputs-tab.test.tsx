/**
 * Outputs tab feature tests (WP-C2.3; console-spec §7.3, W2 step 4 / W3 step
 * 3). File listing with cookie-riding `<a href>` download links to the `/v1`
 * download route, the idle-only `409 session_not_idle` microcopy, the
 * teaching empty state, and generic-failure DP-9 rendering. The API client
 * is a collaborator (fake at the `<ApiClientProvider>` seam).
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

function fakeWithOutputs(): FakeConsoleApi {
  const api = FakeConsoleApi.signedIn(["read"]);
  api.addSession({ id: "sess_01OUT", status: "idle" });
  api.outputs.set("sess_01OUT", ["report.md", "data set.csv"]);
  return api;
}

async function renderOutputsTab(api: FakeConsoleApi, id = "sess_01OUT") {
  const result = renderConsole(api, `/console/sessions/${id}`);
  await screen.findByRole("tablist", { name: "Session detail" });
  await userEvent.setup().click(screen.getByRole("tab", { name: "Outputs" }));
  return result;
}

describe("output files list", () => {
  it("lists the files with download links to the cookie-authed /v1 route", async () => {
    await renderOutputsTab(fakeWithOutputs());
    const list = await screen.findByRole("list", { name: "Output files" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);

    expect(rows[0]).toHaveTextContent("report.md");
    const link = within(rows[0]!).getByRole("link", { name: "Download" });
    expect(link).toHaveAttribute(
      "href",
      "/v1/sessions/sess_01OUT/outputs/report.md",
    );
    expect(link).toHaveAttribute("download", "report.md");

    // Filenames ride percent-encoded in the URL, verbatim in `download`.
    const spaced = within(rows[1]!).getByRole("link", { name: "Download" });
    expect(spaced).toHaveAttribute(
      "href",
      "/v1/sessions/sess_01OUT/outputs/data%20set.csv",
    );
    expect(spaced).toHaveAttribute("download", "data set.csv");
  });

  it("no outputs → the teaching empty state (DP-5/DP-6)", async () => {
    const api = fakeWithOutputs();
    api.outputs.delete("sess_01OUT");
    await renderOutputsTab(api);
    expect(await screen.findByText("No output files")).toBeInTheDocument();
    expect(
      screen.getByText(/\/mnt\/session\/outputs\//),
    ).toBeInTheDocument();
  });
});

describe("idle-only rule (api-reference: 409 session_not_idle)", () => {
  it("a non-idle session gets one line of DP-6 microcopy, not an alarm", async () => {
    const api = FakeConsoleApi.signedIn(["read"]);
    api.addSession({ id: "sess_01RUN", status: "running" });
    await renderOutputsTab(api, "sess_01RUN");

    expect(
      await screen.findByText(/readable only while the session is idle/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Check again" }),
    ).toBeInTheDocument();
  });

  it("any other failure renders the DP-9 facts", async () => {
    const api = fakeWithOutputs();
    api.failGets.set(
      "/v1/sessions/sess_01OUT/outputs",
      new ConsoleApiError("boom", {
        status: 500,
        code: "internal_error",
        requestId: "req_01OUTERR",
      }),
    );
    await renderOutputsTab(api);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("internal_error");
    expect(alert).toHaveTextContent("req_01OUTERR");
  });
});

describe("accessibility", () => {
  it("is axe-clean", async () => {
    const { view } = await renderOutputsTab(fakeWithOutputs());
    await screen.findByRole("list", { name: "Output files" });
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
