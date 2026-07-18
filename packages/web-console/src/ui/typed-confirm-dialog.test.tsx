import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Button } from "./button.js";
import { TypedConfirmDialog } from "./typed-confirm-dialog.js";
import { axe } from "./test-utils.js";

const CONSEQUENCE =
  "Archiving this agent auto-archives 3 scheduled jobs. Archival is terminal.";

function renderDialog(onConfirm = vi.fn(), onClose = vi.fn()) {
  render(
    <TypedConfirmDialog
      open
      onClose={onClose}
      onConfirm={onConfirm}
      title="Archive agent"
      resourceName="pr-reviewer"
      consequence={CONSEQUENCE}
      confirmLabel="Archive"
    />,
  );
  return { onConfirm, onClose };
}

describe("TypedConfirmDialog", () => {
  it("states the consequence and disables confirm until the name matches", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();

    expect(screen.getByText(CONSEQUENCE)).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "Archive" });
    expect(confirm).toBeDisabled();

    const input = screen.getByLabelText('Type "pr-reviewer" to confirm');
    await user.type(input, "pr-review");
    expect(confirm).toBeDisabled();

    await user.type(input, "er");
    expect(confirm).toBeEnabled();

    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("submits from the keyboard once the name matches", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();

    const input = screen.getByLabelText('Type "pr-reviewer" to confirm');
    await user.type(input, "wrong{Enter}");
    expect(onConfirm).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, "pr-reviewer{Enter}");
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("forgets the typed name when reopened", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <div>
          <Button onClick={() => setOpen(true)}>Reopen</Button>
          <TypedConfirmDialog
            open={open}
            onClose={() => setOpen(false)}
            onConfirm={() => {}}
            title="Archive agent"
            resourceName="pr-reviewer"
            consequence={CONSEQUENCE}
          />
        </div>
      );
    }
    render(<Harness />);

    await user.type(
      screen.getByLabelText('Type "pr-reviewer" to confirm'),
      "pr-reviewer",
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Reopen" }));
    expect(
      screen.getByLabelText('Type "pr-reviewer" to confirm'),
    ).toHaveValue("");
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  });

  it("has no axe violations", async () => {
    renderDialog();
    expect(await axe(document.body)).toHaveNoViolations();
  });
});
