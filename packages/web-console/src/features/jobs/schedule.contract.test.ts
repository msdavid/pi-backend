// @vitest-environment node
/**
 * Cross-pinning drift test for the display-side cron replica (WP-C2.4).
 *
 * `./schedule.ts` replicates the backend scheduler's parser + literal
 * wall-clock occurrence resolver (`packages/backend/src/domain/scheduler/
 * cron.ts`, §17.2) because that module cannot ride into a browser bundle.
 * The API carries no server-computed next-fire field (contracts `Job` /
 * api-reference §"Scheduled Jobs"), so the replica is what the jobs list
 * shows — and silent drift between the two implementations would show users
 * a next-fire the scheduler will never honor. This suite imports the REAL
 * backend resolver (exported from `@pi-managed/backend`; node env — the
 * barrel pulls in node-only deps) and pins the replica to it, so any
 * one-sided change fails a test.
 *
 * One KNOWN divergence is pinned explicitly rather than papered over:
 * scan horizon — backend ~4 years, replica ~2 (a display-side cost cap; a
 * match beyond 2 years renders as "—"). Agreement cases resolve well inside
 * both horizons.
 *
 * (A former second divergence — the backend's ±2h scan window centered on
 * naïve-UTC, which made zones with |offset| > 2h never fire — was fixed in
 * the backend; those zones now live in the agreement cases below, and the
 * backend regression pin is `packages/backend/src/domain/scheduler/
 * __tests__/cron.test.ts`.)
 */
import { describe, expect, it } from "vitest";
import { nextOccurrence, parseCron } from "@pi-managed/backend";

import { nextFire } from "./schedule.js";

/**
 * cron × tz × start instants both resolvers must agree on, covering the
 * §17.2 semantics: plain shapes, steps/lists/ranges, the POSIX dom/dow
 * either-matches rule, DST spring-forward skip and fall-back double-fire
 * (Europe/Berlin: 2026-03-29 skips 02:xx, 2026-10-25 repeats 02:xx — within
 * the backend's working ±2h offset range), and a leap-day cron. `chain`
 * bounds the successive occurrences compared (default 5; the leap-day case
 * stops at 1 — its SECOND occurrence sits past the replica's 2-year
 * horizon, divergence 2 above).
 */
const CASES: Array<{ cron: string; tz: string; after: string; chain?: number }> = [
  { cron: "* * * * *", tz: "UTC", after: "2026-07-15T06:00:30Z" },
  { cron: "0 7 * * *", tz: "UTC", after: "2026-07-15T06:59:00Z" },
  { cron: "0 7 * * *", tz: "UTC", after: "2026-07-15T07:00:00Z" }, // strictly-after
  { cron: "*/15 * * * *", tz: "UTC", after: "2026-07-15T06:07:00Z" },
  { cron: "30 9 * * 1,3", tz: "UTC", after: "2026-07-17T00:00:00Z" },
  { cron: "0 7 * * 1-5", tz: "UTC", after: "2026-07-18T00:00:00Z" }, // weekend gap
  { cron: "0 0 1 * *", tz: "UTC", after: "2026-07-15T00:00:00Z" }, // month rollover
  { cron: "5 4-6/2 * * *", tz: "UTC", after: "2026-07-15T04:30:00Z" }, // ranged step
  { cron: "0 12 13 * 5", tz: "UTC", after: "2026-07-15T00:00:00Z" }, // dom OR dow (POSIX)
  { cron: "0 8 29 2 *", tz: "UTC", after: "2027-01-01T00:00:00Z", chain: 1 }, // leap day
  { cron: "30 2 * * *", tz: "Europe/Berlin", after: "2026-03-28T12:00:00Z" }, // spring-forward skip
  { cron: "30 2 * * *", tz: "Europe/Berlin", after: "2026-10-24T12:00:00Z" }, // fall-back double-fire
  { cron: "45 23 * * 0", tz: "Europe/London", after: "2026-07-15T00:00:00Z" },
  // Far-offset zones (|UTC offset| > 2h) — agree since the backend
  // scan-window fix; see header note.
  { cron: "0 9 * * *", tz: "Asia/Taipei", after: "2026-07-15T00:00:00Z" },
  { cron: "0 9 * * *", tz: "America/New_York", after: "2026-07-15T00:00:00Z" },
  { cron: "30 2 * * *", tz: "America/New_York", after: "2026-03-07T12:00:00Z" }, // spring-forward skip, far offset
  { cron: "30 1 * * *", tz: "America/New_York", after: "2026-10-31T12:00:00Z" }, // fall-back double-fire, far offset
];

describe("schedule.ts replica ↔ backend scheduler resolver (drift pin)", () => {
  it.each(CASES)(
    "agrees on successive occurrences of '$cron' in $tz",
    ({ cron, tz, after, chain = 5 }) => {
      let cursor = new Date(after);
      for (let i = 0; i < chain; i += 1) {
        const replica = nextFire({ cron, tz }, cursor);
        const backend = nextOccurrence(cron, tz, cursor);
        expect(
          replica?.toISOString(),
          `occurrence ${i} after ${cursor.toISOString()}`,
        ).toBe(backend?.toISOString());
        if (!replica) break;
        cursor = replica;
      }
    },
  );

  it("rejects exactly what the backend parser rejects", () => {
    const invalid = [
      "not a cron",
      "* * * *", // 4 fields
      "* * * * * *", // 6 fields
      "61 * * * *", // minute out of range
      "0 24 * * *", // hour out of range
      "0 7 0 * *", // dom out of range
      "0 7 * 13 *", // month out of range
      "0 7 * * 8", // dow out of range (7 is Sunday, 8 is not)
      "*/0 * * * *", // zero step
    ];
    for (const cron of invalid) {
      expect(() => parseCron(cron), cron).toThrow();
      expect(nextFire({ cron, tz: "UTC" }), cron).toBeNull();
    }
  });

  it("accepts the same edge spellings the backend accepts", () => {
    // dow 7 ≡ 0 (Sunday), lists mixing ranges and steps.
    for (const cron of ["0 7 * * 7", "0 7 * * 0", "1,31-59/7 * * * *"]) {
      expect(() => parseCron(cron), cron).not.toThrow();
      expect(
        nextFire({ cron, tz: "UTC" }, new Date("2026-07-15T00:00:00Z")),
        cron,
      ).not.toBeNull();
    }
  });
});
