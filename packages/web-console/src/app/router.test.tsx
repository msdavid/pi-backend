/**
 * Router smoke test: the router (basepath /console) mounts behind the auth
 * gate, and lazy route chunks load and render inside the shell. Auth is a
 * collaborator here — a signed-in fake client is injected at the
 * `<ApiClientProvider>` seam.
 */
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FakeConsoleApi } from "../test/fake-console-api.js";
import { renderConsole } from "../test/render-console.js";
import "../ui/test-utils.js"; // afterEach(cleanup)

describe("console router", () => {
  it("serves the home route under the /console basepath", async () => {
    renderConsole(FakeConsoleApi.signedIn(["read"]), "/console/");
    // Shell chrome…
    expect(await screen.findByText("Pi Console")).toBeInTheDocument();
    // …and the lazily loaded home route.
    expect(
      await screen.findByRole("heading", { name: "Home" }),
    ).toBeInTheDocument();
  });

  it("serves a lazily loaded section route by path", async () => {
    renderConsole(FakeConsoleApi.signedIn(["read"]), "/console/sessions");
    expect(
      await screen.findByRole("heading", { name: "Sessions" }),
    ).toBeInTheDocument();
  });
});
