/**
 * Failed-auth throttle tests (SEC-1) — pure unit, no HTTP stack.
 *
 * Verifies the per-source budget the auth hook enforces before argon2:
 * - a source under budget is not blocked;
 * - it becomes blocked once it exceeds maxFailures in a window;
 * - the window resets, restoring the budget;
 * - a successful auth clears the source's failures;
 * - expired records are swept so the map stays bounded.
 */

import { describe, expect, it } from "vitest";
import { FailedAuthThrottle } from "../auth.js";

describe("FailedAuthThrottle", () => {
  it("blocks a source only after it exceeds maxFailures in the window", () => {
    const now = 0;
    const t = new FailedAuthThrottle({ maxFailures: 3, windowMs: 1_000, now: () => now });
    expect(t.isBlocked("1.2.3.4")).toBe(false);
    for (let i = 0; i < 3; i++) {
      expect(t.isBlocked("1.2.3.4")).toBe(false);
      t.recordFailure("1.2.3.4");
    }
    // 3 failures recorded → at the limit → subsequent attempts blocked.
    expect(t.isBlocked("1.2.3.4")).toBe(true);
  });

  it("resets the budget once the window elapses", () => {
    let now = 0;
    const t = new FailedAuthThrottle({ maxFailures: 2, windowMs: 1_000, now: () => now });
    t.recordFailure("ip");
    t.recordFailure("ip");
    expect(t.isBlocked("ip")).toBe(true);
    now = 1_000;
    expect(t.isBlocked("ip")).toBe(false);
  });

  it("a successful auth clears the source's failures", () => {
    const now = 0;
    const t = new FailedAuthThrottle({ maxFailures: 2, windowMs: 1_000, now: () => now });
    t.recordFailure("ip");
    t.recordFailure("ip");
    expect(t.isBlocked("ip")).toBe(true);
    t.recordSuccess("ip");
    expect(t.isBlocked("ip")).toBe(false);
    expect(t.size()).toBe(0);
  });

  it("sweeps expired records so the map stays bounded", () => {
    let now = 0;
    const t = new FailedAuthThrottle({ maxFailures: 1, windowMs: 1_000, now: () => now });
    t.recordFailure("a");
    expect(t.size()).toBe(1);
    // A later failure from a different source triggers a sweep of the expired one.
    now = 2_000;
    t.recordFailure("b");
    expect(t.size()).toBe(1);
    expect(t.isBlocked("a")).toBe(false);
  });
});
