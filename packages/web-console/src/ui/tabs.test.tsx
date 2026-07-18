import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Tabs } from "./tabs.js";
import { axe } from "./test-utils.js";

const TABS = [
  { id: "trace", label: "Trace", content: <p>trace entries</p> },
  { id: "tree", label: "Tree", content: <p>fork tree</p> },
  { id: "usage", label: "Usage", content: <p>tokens and usd</p> },
];

describe("Tabs", () => {
  it("renders the ARIA tabs pattern with the first tab selected", () => {
    render(<Tabs tabs={TABS} label="Session detail" />);

    expect(
      screen.getByRole("tablist", { name: "Session detail" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Trace", selected: true }))
      .toBeInTheDocument();
    expect(screen.getByRole("tabpanel", { name: "Trace" })).toHaveTextContent(
      "trace entries",
    );
    // Inactive panels are not rendered at all (DP-2).
    expect(screen.queryByText("fork tree")).toBeNull();
  });

  it("switches panels on click and reports the change", async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();
    render(<Tabs tabs={TABS} label="Session detail" onTabChange={onTabChange} />);

    await user.click(screen.getByRole("tab", { name: "Usage" }));
    expect(screen.getByRole("tabpanel", { name: "Usage" })).toHaveTextContent(
      "tokens and usd",
    );
    expect(onTabChange).toHaveBeenCalledWith("usage");
  });

  it("moves selection with arrow keys, wrapping, plus Home/End", async () => {
    const user = userEvent.setup();
    render(<Tabs tabs={TABS} label="Session detail" />);

    await user.tab(); // roving tabindex: only the selected tab is tabbable
    expect(screen.getByRole("tab", { name: "Trace" })).toHaveFocus();

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Tree", selected: true }))
      .toHaveFocus();

    await user.keyboard("{ArrowLeft}{ArrowLeft}"); // wraps backward
    expect(screen.getByRole("tab", { name: "Usage", selected: true }))
      .toHaveFocus();

    await user.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "Trace", selected: true }))
      .toHaveFocus();

    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Usage", selected: true }))
      .toHaveFocus();
  });

  it("honors defaultTabId", () => {
    render(<Tabs tabs={TABS} label="Session detail" defaultTabId="tree" />);
    expect(screen.getByRole("tab", { name: "Tree", selected: true }))
      .toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    const { container } = render(<Tabs tabs={TABS} label="Session detail" />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
