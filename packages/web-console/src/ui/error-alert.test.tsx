import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ConsoleApiError } from "../api/client.js";
import { errorDocsUrl } from "../lib/errors.js";
import { ErrorAlert } from "./error-alert.js";
import { axe } from "./test-utils.js";

describe("ErrorAlert (DP-9)", () => {
  it("renders the message, machine facts, and a docs link (console-spec §6.4)", () => {
    render(
      <ErrorAlert
        label="sessions"
        error={
          new ConsoleApiError("Tenant rate limit exceeded.", {
            status: 429,
            code: "rate_limited",
            requestId: "req_01RATE",
          })
        }
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "Failed to load sessions: Tenant rate limit exceeded. (rate_limited · req_01RATE)",
    );
    const docs = within(alert).getByRole("link", { name: "docs" });
    expect(docs).toHaveAttribute("href", errorDocsUrl());
    expect(docs).toHaveAttribute(
      "href",
      "https://github.com/msdavid/pi-backend/blob/main/docs/api-reference.md#error-envelope",
    );
  });

  it("renders plain errors with the docs link too", () => {
    render(<ErrorAlert label="usage" error={new Error("boom")} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Failed to load usage: boom");
    expect(within(alert).getByRole("link", { name: "docs" })).toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <ErrorAlert label="sessions" error={new Error("boom")} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
