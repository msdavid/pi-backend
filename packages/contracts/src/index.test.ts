import { describe, it, expect } from "vitest";
import { CONTRACTS_VERSION } from "./index.js";

describe("contracts scaffold", () => {
  it("exports a version constant", () => {
    expect(CONTRACTS_VERSION).toBe("0.0.0");
  });

  it("trivial arithmetic passes", () => {
    expect(1 + 1).toBe(2);
  });
});
