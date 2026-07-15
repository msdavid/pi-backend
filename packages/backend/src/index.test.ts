import { describe, it, expect } from "vitest";
import { BACKEND_VERSION } from "./index.js";

describe("backend scaffold", () => {
  it("exports a version constant", () => {
    expect(BACKEND_VERSION).toBe("0.0.0");
  });

  it("trivial arithmetic passes", () => {
    expect(1 + 1).toBe(2);
  });
});
