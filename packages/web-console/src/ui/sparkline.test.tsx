import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Sparkline } from "./sparkline.js";
import { axe } from "./test-utils.js";

describe("Sparkline", () => {
  it("renders one polyline point per value, scaled into the viewBox", () => {
    const { container } = render(
      <Sparkline values={[0, 5, 10]} width={100} height={20} />,
    );

    const polyline = container.querySelector("polyline");
    const points = polyline?.getAttribute("points")?.split(" ") ?? [];
    expect(points).toHaveLength(3);
    // min maps to the bottom, max to the top (y is inverted in SVG).
    expect(points[0]).toBe("2,18");
    expect(points[2]).toBe("98,2");
  });

  it("renders a flat midline for a constant series", () => {
    const { container } = render(
      <Sparkline values={[3, 3]} width={100} height={20} />,
    );
    const ys = (
      container.querySelector("polyline")?.getAttribute("points") ?? ""
    )
      .split(" ")
      .map((p) => p.split(",")[1]);
    expect(new Set(ys).size).toBe(1);
  });

  it("renders nothing with fewer than two points", () => {
    const { container } = render(<Sparkline values={[42]} />);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("is decorative without a label and an img with one", () => {
    const { container, rerender } = render(<Sparkline values={[1, 2]} />);
    expect(container.querySelector("svg")).toHaveAttribute(
      "aria-hidden",
      "true",
    );

    rerender(<Sparkline values={[1, 2]} label="Spend, last 7 days" />);
    expect(
      screen.getByRole("img", { name: "Spend, last 7 days" }),
    ).toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <div>
        <Sparkline values={[1, 4, 2, 8]} label="Active sessions trend" />
        <Sparkline values={[1, 4, 2, 8]} />
      </div>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
