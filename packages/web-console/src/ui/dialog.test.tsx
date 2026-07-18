import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Button } from "./button.js";
import { Dialog } from "./dialog.js";
import { axe } from "./test-utils.js";

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Button onClick={() => setOpen(true)}>Open</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Archive agent">
        <Button onClick={() => setOpen(false)}>Cancel</Button>
        <Button variant="destructive">Archive</Button>
      </Dialog>
    </div>
  );
}

describe("Dialog", () => {
  it("renders nothing while closed", () => {
    render(
      <Dialog open={false} onClose={() => {}} title="Hidden">
        <p>body</p>
      </Dialog>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens as a modal named by its title and focuses inside", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Open" }));

    const dialog = screen.getByRole("dialog", { name: "Archive agent" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("traps Tab within the dialog in both directions", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Open" }));

    // Forward: Cancel -> Archive -> wraps to Cancel.
    await user.tab();
    expect(screen.getByRole("button", { name: "Archive" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    // Backward from the first element wraps to the last.
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Archive" })).toHaveFocus();
  });

  it("closes on Escape and restores focus to the opener", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open" });

    await user.click(opener);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("closes on backdrop click but not on panel click", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="T">
        <p>body</p>
      </Dialog>,
    );

    await user.click(screen.getByText("body"));
    expect(onClose).not.toHaveBeenCalled();

    const backdrop = screen.getByRole("dialog").parentElement;
    await user.click(backdrop as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("has no axe violations while open", async () => {
    render(
      <Dialog open onClose={() => {}} title="Archive agent">
        <p>This cannot be undone.</p>
        <Button>Cancel</Button>
      </Dialog>,
    );
    expect(await axe(document.body)).toHaveNoViolations();
  });
});
