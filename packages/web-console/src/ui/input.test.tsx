import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { Input } from "./input.js";
import { axe } from "./test-utils.js";

describe("Input", () => {
  it("associates the label and accepts typing", async () => {
    const user = userEvent.setup();
    render(<Input label="Agent name" />);

    const input = screen.getByLabelText("Agent name");
    await user.type(input, "reviewer");
    expect(input).toHaveValue("reviewer");
  });

  it("wires hint and error into the accessible description", () => {
    render(
      <Input
        label="Cron expression"
        hint="Five fields, UTC."
        error="Invalid cron expression."
      />,
    );

    const input = screen.getByLabelText("Cron expression");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(
      "Invalid cron expression. Five fields, UTC.",
    );
  });

  it("is not marked invalid without an error", () => {
    render(<Input label="Name" />);
    expect(screen.getByLabelText("Name")).not.toHaveAttribute("aria-invalid");
  });

  it("has no axe violations, including in the error state", async () => {
    const { container } = render(
      <div>
        <Input label="Name" hint="Lowercase, no spaces." />
        <Input label="Schedule" error="Required." />
      </div>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
