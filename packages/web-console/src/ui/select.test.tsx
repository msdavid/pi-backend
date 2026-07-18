import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Select } from "./select.js";
import { axe } from "./test-utils.js";

function renderStatusSelect(onChange = vi.fn()) {
  render(
    <Select label="Status" hint="Session lifecycle state" onChange={onChange}>
      <option value="">all</option>
      <option value="idle">idle</option>
      <option value="running">running</option>
    </Select>,
  );
  return onChange;
}

describe("Select", () => {
  it("associates the label and the hint with the control", () => {
    renderStatusSelect();
    const select = screen.getByLabelText("Status");
    expect(select).toHaveAccessibleDescription("Session lifecycle state");
  });

  it("fires onChange with the picked option", async () => {
    const user = userEvent.setup();
    const onChange = renderStatusSelect();
    await user.selectOptions(screen.getByLabelText("Status"), "running");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Status")).toHaveValue("running");
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <Select label="Status">
        <option value="">all</option>
      </Select>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
