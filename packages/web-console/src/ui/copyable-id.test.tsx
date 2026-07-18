import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { CopyableId, truncateMiddle } from "./copyable-id.js";
import { axe } from "./test-utils.js";

const LONG_ID = "sess_01J8ZQ4X5Y6Z7A8B9C0D1E2F3G";

describe("truncateMiddle", () => {
  it("returns short values unchanged", () => {
    expect(truncateMiddle("sess_abc", 24)).toBe("sess_abc");
  });

  it("keeps the prefix and the tail around one ellipsis", () => {
    const out = truncateMiddle(LONG_ID, 24);
    expect(out).toHaveLength(24);
    expect(out.startsWith("sess_")).toBe(true);
    expect(out).toContain("…");
    expect(out.endsWith(LONG_ID.slice(-5))).toBe(true);
  });
});

describe("CopyableId", () => {
  it("renders the truncated id in mono with the full id as title", () => {
    render(<CopyableId id={LONG_ID} />);
    const code = screen.getByTitle(LONG_ID);
    expect(code.textContent).toContain("…");
  });

  it("copies the FULL id on click and announces it", async () => {
    const user = userEvent.setup();
    render(<CopyableId id={LONG_ID} />);

    await user.click(screen.getByRole("button", { name: `Copy ${LONG_ID}` }));

    expect(await window.navigator.clipboard.readText()).toBe(LONG_ID);
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
  });

  it("wraps the id in the supplied link, keeping the copy button outside it", async () => {
    const user = userEvent.setup();
    render(
      <CopyableId
        id={LONG_ID}
        link={(id) => <a href={`/console/sessions/${LONG_ID}`}>{id}</a>}
      />,
    );
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", `/console/sessions/${LONG_ID}`);
    expect(link).toContainElement(screen.getByTitle(LONG_ID));
    // Copy still works and copies the full id.
    await user.click(screen.getByRole("button", { name: `Copy ${LONG_ID}` }));
    expect(await window.navigator.clipboard.readText()).toBe(LONG_ID);
  });

  it("copy click does not bubble to an interactive ancestor (table rows)", async () => {
    const user = userEvent.setup();
    let activations = 0;
    render(
      <div
        role="button"
        tabIndex={0}
        onClick={() => {
          activations += 1;
        }}
      >
        <CopyableId id={LONG_ID} />
      </div>,
    );
    await user.click(screen.getByRole("button", { name: `Copy ${LONG_ID}` }));
    expect(activations).toBe(0);
  });

  it("has no axe violations", async () => {
    const { container } = render(<CopyableId id={LONG_ID} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
