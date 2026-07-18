import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { Button } from "./button.js";
import { EmptyState } from "./empty-state.js";
import { axe } from "./test-utils.js";

const CLI = "pi remote session new --agent pr-reviewer";

describe("EmptyState", () => {
  it("teaches: title, microcopy, create action, and the CLI equivalent", () => {
    render(
      <EmptyState
        title="No sessions yet"
        description="A session is one run of an agent in its environment."
        cliCommand={CLI}
      >
        <Button variant="primary">New session</Button>
      </EmptyState>,
    );

    expect(
      screen.getByRole("heading", { name: "No sessions yet" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("A session is one run of an agent in its environment."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "New session" }),
    ).toBeInTheDocument();
    expect(screen.getByText(CLI)).toBeInTheDocument();
  });

  it("copies the CLI command with one click", async () => {
    const user = userEvent.setup();
    render(<EmptyState title="No sessions yet" cliCommand={CLI} />);

    const button = screen.getByRole("button", {
      name: `Copy command: ${CLI}`,
    });
    await user.click(button);
    expect(await window.navigator.clipboard.readText()).toBe(CLI);
    expect(button).toHaveTextContent("Copied");
  });

  it("omits the CLI slot when no command is given", () => {
    render(<EmptyState title="No files" />);
    expect(screen.queryByText("Or from the CLI:")).toBeNull();
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <EmptyState
        title="No sessions yet"
        description="A session is one run of an agent in its environment."
        cliCommand={CLI}
      >
        <Button variant="primary">New session</Button>
      </EmptyState>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
