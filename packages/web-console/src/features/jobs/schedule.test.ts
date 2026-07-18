/**
 * Cron display helpers (WP-C2.4): the human-readable phrase and the
 * next-fire computation, mirroring the backend's literal wall-clock
 * semantics (`packages/backend/src/domain/scheduler/cron.ts`, §17.2) —
 * plus the WP-C3.5 create-form validation messages.
 */
import { describe, expect, it } from "vitest";

import { cronError, describeCron, nextFire, timeZoneError } from "./schedule.js";

describe("describeCron", () => {
  it("phrases the common shapes", () => {
    expect(describeCron("* * * * *")).toBe("every minute");
    expect(describeCron("*/15 * * * *")).toBe("every 15 minutes");
    expect(describeCron("30 * * * *")).toBe("hourly at :30");
    expect(describeCron("0 7 * * *")).toBe("daily at 07:00");
    expect(describeCron("0 7 * * 1-5")).toBe("weekdays at 07:00");
    expect(describeCron("30 9 * * 1,3")).toBe("on Mon, Wed at 09:30");
    expect(describeCron("0 0 1 * *")).toBe("monthly on day 1 at 00:00");
  });

  it("falls back to the raw expression for irregular or invalid shapes", () => {
    // dom AND dow restricted (POSIX either-matches) — no honest phrase.
    expect(describeCron("0 7 1 * 1")).toBe("0 7 1 * 1");
    // restricted month.
    expect(describeCron("0 7 * 6 *")).toBe("0 7 * 6 *");
    // malformed.
    expect(describeCron("not a cron")).toBe("not a cron");
  });
});

describe("nextFire", () => {
  it("finds the next daily occurrence in UTC (same day, then rollover)", () => {
    const schedule = { cron: "0 7 * * *", tz: "UTC" };
    expect(
      nextFire(schedule, new Date("2026-07-15T06:00:00Z"))?.toISOString(),
    ).toBe("2026-07-15T07:00:00.000Z");
    expect(
      nextFire(schedule, new Date("2026-07-15T08:00:00Z"))?.toISOString(),
    ).toBe("2026-07-16T07:00:00.000Z");
    // Strictly after: an occurrence at exactly `after` is skipped.
    expect(
      nextFire(schedule, new Date("2026-07-15T07:00:00Z"))?.toISOString(),
    ).toBe("2026-07-16T07:00:00.000Z");
  });

  it("respects day-of-week restrictions (weekdays cron over a weekend)", () => {
    // 2026-07-18 is a Saturday; next weekday fire is Monday the 20th.
    expect(
      nextFire(
        { cron: "0 7 * * 1-5", tz: "UTC" },
        new Date("2026-07-18T00:00:00Z"),
      )?.toISOString(),
    ).toBe("2026-07-20T07:00:00.000Z");
  });

  it("matches the wall clock in the schedule's tz, skipping spring-forward gaps", () => {
    // America/New_York springs forward 2026-03-08: 02:30 EST does not exist
    // that day (§17.2 literal wall-clock skip) — the next 02:30 is on the
    // 9th, in EDT (UTC-4 → 06:30Z).
    expect(
      nextFire(
        { cron: "30 2 * * *", tz: "America/New_York" },
        new Date("2026-03-08T00:00:00Z"),
      )?.toISOString(),
    ).toBe("2026-03-09T06:30:00.000Z");
  });

  it("double-fires across a fall-back overlap (§17.2)", () => {
    // America/New_York falls back 2026-11-01: 01:30 EDT (05:30Z) and
    // 01:30 EST (06:30Z) both exist — two successive occurrences.
    const schedule = { cron: "30 1 * * *", tz: "America/New_York" };
    const first = nextFire(schedule, new Date("2026-11-01T00:00:00Z"));
    expect(first?.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    const second = nextFire(schedule, first!);
    expect(second?.toISOString()).toBe("2026-11-01T06:30:00.000Z");
  });

  it("returns null for malformed input", () => {
    expect(nextFire({ cron: "bad", tz: "UTC" })).toBeNull();
    expect(nextFire({ cron: "0 7 * * *", tz: "Not/AZone" })).toBeNull();
  });
});

describe("create-form validation (WP-C3.5)", () => {
  it("cronError: null for valid expressions, the parse message otherwise", () => {
    expect(cronError("0 7 * * 1-5")).toBeNull();
    expect(cronError("*/15 * * * *")).toBeNull();
    expect(cronError("0 7 * *")).toMatch(/exactly 5 fields/);
    expect(cronError("61 7 * * *")).toMatch(/out-of-range/);
    expect(cronError("a b c d e")).toMatch(/invalid value/);
  });

  it("timeZoneError: null for IANA zones Intl knows, a message otherwise", () => {
    expect(timeZoneError("UTC")).toBeNull();
    expect(timeZoneError("America/New_York")).toBeNull();
    expect(timeZoneError("Mars/Olympus_Mons")).toBe(
      "unknown IANA timezone: Mars/Olympus_Mons",
    );
    expect(timeZoneError("")).toBe("unknown IANA timezone: ");
  });
});
