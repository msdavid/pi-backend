import { describe, it, expect } from "vitest";
import { Poller, WebhookMode, BuiltinExecutor, SpawnExecutor, loadConfig } from "./index.js";

describe("worker package surface", () => {
  it("exports the main classes + config loader", () => {
    expect(Poller).toBeTypeOf("function");
    expect(WebhookMode).toBeTypeOf("function");
    expect(BuiltinExecutor).toBeTypeOf("function");
    expect(SpawnExecutor).toBeTypeOf("function");
    expect(loadConfig).toBeTypeOf("function");
  });

  it("trivial arithmetic passes", () => {
    expect(1 + 1).toBe(2);
  });
});
