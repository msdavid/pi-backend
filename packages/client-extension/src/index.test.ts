import { describe, it, expect } from "vitest";
import { CLIENT_EXTENSION_VERSION } from "./index.js";

describe("client-extension scaffold", () => {
  it("exports a version constant", () => {
    expect(CLIENT_EXTENSION_VERSION).toBe("0.0.0");
  });

  it("trivial arithmetic passes", () => {
    expect(1 + 1).toBe(2);
  });
});
