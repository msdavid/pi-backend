import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { JsonViewer, summarize } from "./json-viewer.js";
import { axe } from "./test-utils.js";

describe("summarize", () => {
  it("describes shapes without rendering their contents", () => {
    expect(summarize({ a: 1, b: 2 })).toBe("{…} 2 keys");
    expect(summarize({ a: 1 })).toBe("{…} 1 key");
    expect(summarize([1, 2, 3])).toBe("[…] 3 items");
    expect(summarize("hi")).toBe('"hi"');
    expect(summarize(null)).toBe("null");
  });
});

describe("JsonViewer", () => {
  const PAYLOAD = { tool: "bash", input: { command: "ls" }, exitCode: 0 };

  it("starts collapsed: summary only, payload not in the DOM", () => {
    render(<JsonViewer value={PAYLOAD} label="tool input" />);

    const toggle = screen.getByRole("button", { expanded: false });
    expect(toggle).toHaveTextContent("tool input");
    expect(toggle).toHaveTextContent("{…} 3 keys");
    // DP-2: nothing of the payload rendered while collapsed.
    expect(screen.queryByText(/"command"/)).toBeNull();
  });

  it("expands to pretty-printed JSON and collapses again", async () => {
    const user = userEvent.setup();
    render(<JsonViewer value={PAYLOAD} />);

    await user.click(screen.getByRole("button", { expanded: false }));
    const toggle = screen.getByRole("button", { expanded: true });
    expect(screen.getByText(/"command": "ls"/)).toBeInTheDocument();

    await user.click(toggle);
    expect(screen.queryByText(/"command": "ls"/)).toBeNull();
  });

  it("is keyboard-operable", async () => {
    const user = userEvent.setup();
    render(<JsonViewer value={PAYLOAD} />);

    await user.tab();
    expect(screen.getByRole("button", { expanded: false })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument();
  });

  it("survives non-serializable values", async () => {
    const user = userEvent.setup();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    render(<JsonViewer value={circular} />);

    await user.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("[unserializable value]")).toBeInTheDocument();
  });

  it("has no axe violations, collapsed and expanded", async () => {
    const user = userEvent.setup();
    const { container } = render(<JsonViewer value={PAYLOAD} label="payload" />);
    expect(await axe(container)).toHaveNoViolations();

    await user.click(screen.getByRole("button", { expanded: false }));
    expect(await axe(container)).toHaveNoViolations();
  });
});
