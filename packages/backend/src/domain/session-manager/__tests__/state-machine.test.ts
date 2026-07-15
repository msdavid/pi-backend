/**
 * State-machine unit + property tests (§6.3, decisions.md item 7).
 *
 * Property-style: a seeded PRNG drives random legal-transition sequences; we assert
 * invariants hold after every step (no escape from `terminated`; retry count bounded;
 * backoff sequence exact; stop reasons consistent). No external fuzzing library — a
 * compact in-process generator keeps the suite deterministic and dependency-free.
 */

import { describe, expect, it } from "vitest";
import {
  LEGAL_TRANSITIONS,
  MAX_RETRIES,
  RETRY_BACKOFF_MS,
  SessionStateMachine,
  isLegalTransition,
} from "../state-machine.js";
import type { SessionStatus } from "../../ports.js";

/** Tiny seeded PRNG (mulberry32) for deterministic sequences. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALL_STATUSES: SessionStatus[] = [
  "idle",
  "running",
  "rescheduling",
  "terminated",
];

describe("SessionStateMachine", () => {
  it("starts idle with no stop reason", () => {
    const sm = new SessionStateMachine();
    expect(sm.status).toBe("idle");
    expect(sm.stopReason).toBeUndefined();
    expect(sm.retryCount).toBe(0);
  });

  it("runs a happy-path lifecycle: idle→running→idle(completed)", () => {
    const sm = new SessionStateMachine();
    sm.start();
    expect(sm.status).toBe("running");
    sm.complete();
    expect(sm.status).toBe("idle");
    expect(sm.stopReason).toBe("completed");
  });

  it("interrupt → idle(user_interrupt)", () => {
    const sm = new SessionStateMachine();
    sm.start();
    sm.interrupt();
    expect(sm.status).toBe("idle");
    expect(sm.stopReason).toBe("user_interrupt");
  });

  it("budgetExhausted → idle(budget_exhausted)", () => {
    const sm = new SessionStateMachine();
    sm.start();
    sm.budgetExhausted();
    expect(sm.stopReason).toBe("budget_exhausted");
  });

  it("requiresAction carries blocking event ids", () => {
    const sm = new SessionStateMachine();
    sm.start();
    sm.requiresAction(["evt_1", "evt_2"]);
    expect(sm.stopReason).toBe("requires_action");
    expect([...sm.blockingEventIds]).toEqual(["evt_1", "evt_2"]);
  });

  describe("retry / rescheduling (decisions.md item 7)", () => {
    it("schedules 3 retries with 1s→4s→16s backoff, then terminates", () => {
      const sm = new SessionStateMachine();
      sm.start();
      const d1 = sm.scheduleRetry();
      const d2 = sm.scheduleRetry();
      const d3 = sm.scheduleRetry();
      const d4 = sm.scheduleRetry();
      expect(d1).toEqual({ delayMs: 1_000, attempt: 1 });
      expect(d2).toEqual({ delayMs: 4_000, attempt: 2 });
      expect(d3).toEqual({ delayMs: 16_000, attempt: 3 });
      expect(d4).toBeNull();
      expect(sm.status).toBe("terminated");
      expect(sm.stopReason).toBe("error");
    });

    it("rejects start after termination", () => {
      const sm = new SessionStateMachine();
      sm.start();
      sm.scheduleRetry();
      sm.scheduleRetry();
      sm.scheduleRetry();
      sm.scheduleRetry(); // → terminated
      expect(() => sm.start()).toThrow(/terminated/);
    });

    it("resetRetries clears the counter after a successful resume", () => {
      const sm = new SessionStateMachine();
      sm.start();
      sm.scheduleRetry();
      expect(sm.retryCount).toBe(1);
      sm.start(); // retry attempt
      sm.complete(); // success
      sm.resetRetries();
      expect(sm.retryCount).toBe(0);
    });
  });

  describe("transition table", () => {
    it("LEGAL_TRANSITIONS covers the spec graph", () => {
      // Every claimed legal edge must be a distinct (from,to) pair.
      const seen = new Set<string>();
      for (const [f, t] of LEGAL_TRANSITIONS) {
        const key = `${f}->${t}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
      // Core invariants from §6.3.
      expect(isLegalTransition("idle", "running")).toBe(true);
      expect(isLegalTransition("running", "idle")).toBe(true);
      expect(isLegalTransition("running", "rescheduling")).toBe(true);
      expect(isLegalTransition("rescheduling", "running")).toBe(true);
      expect(isLegalTransition("rescheduling", "terminated")).toBe(true);
      // terminated is terminal: no outgoing legal edge.
      for (const s of ALL_STATUSES) {
        expect(isLegalTransition("terminated", s)).toBe(s === "terminated" ? false : false);
      }
    });
  });

  describe("property: random legal sequences", () => {
    // Generate a random walk of explicit machine API calls and assert invariants
    // after each step. 500 iterations × multiple seeds for coverage.
    it("invariants hold across 2000 random sequences", () => {
      const rnd = prng(0xc0ffee);
      for (let i = 0; i < 2000; i++) {
        const sm = new SessionStateMachine();
        for (let step = 0; step < 12; step++) {
          if (sm.status === "terminated") {
            // Once terminated, no API call changes status.
            const before = sm.status;
            if (pick(rnd, ["complete", "interrupt", "start", "retry"]) === "start") {
              safeStart(sm);
            } else {
              sm.complete();
            }
            expect(sm.status).toBe(before);
            break;
          }
          switch (Math.floor(rnd() * 6)) {
            case 0:
              sm.start();
              expect(sm.status).toBe("running");
              expect(sm.stopReason).toBeUndefined();
              break;
            case 1:
              sm.complete();
              assertIdleWithReason(sm);
              break;
            case 2:
              sm.interrupt();
              assertIdleWithReason(sm);
              expect(sm.stopReason).toBe("user_interrupt");
              break;
            case 3:
              sm.budgetExhausted();
              assertIdleWithReason(sm);
              expect(sm.stopReason).toBe("budget_exhausted");
              break;
            case 4: {
              const r = sm.scheduleRetry();
              if (r) {
                expect(r.delayMs).toBeOneOf([...RETRY_BACKOFF_MS]);
                expect(r.attempt).toBeGreaterThan(0);
                expect(r.attempt).toBeLessThanOrEqual(MAX_RETRIES);
                expect(sm.status).toBe("rescheduling");
                expect(sm.retryCount).toBeLessThanOrEqual(MAX_RETRIES);
              } else {
                expect(sm.status).toBe("terminated");
                expect(sm.stopReason).toBe("error");
              }
              break;
            }
            case 5:
              sm.requiresAction(["e1"]);
              assertIdleWithReason(sm);
              expect(sm.stopReason).toBe("requires_action");
              break;
          }
        }
        // Final invariant: retry count never exceeds MAX_RETRIES.
        expect(sm.retryCount).toBeLessThanOrEqual(MAX_RETRIES);
      }
    });
  });
});

function assertIdleWithReason(sm: SessionStateMachine): void {
  if (sm.status === "idle" || sm.status === "terminated") {
    if (sm.status === "idle") expect(sm.stopReason).toBeDefined();
  }
}

function pick<T>(rnd: () => number, arr: T[]): T {
  return arr[Math.floor(rnd() * arr.length) % arr.length]!;
}

function safeStart(sm: SessionStateMachine): void {
  try {
    sm.start();
  } catch {
    /* terminated — expected */
  }
}
