/**
 * Cron wall-clock → UTC instant resolution (§17.2).
 *
 * Regression anchor: `instantsForWallClock` used to scan ±2h around the
 * wall-clock naïvely interpreted as UTC, which put every timezone with
 * |UTC offset| > 2h permanently outside the window — `nextOccurrence`
 * returned `null` and scheduled jobs in e.g. America/New_York or Asia/Taipei
 * never fired. The window is now centered on the zone's probed offset; these
 * tests pin the far-offset zones plus the DST gap/overlap semantics the
 * scanner must preserve.
 */

import { describe, expect, it } from "vitest";
import { instantsForWallClock, nextOccurrence } from "../cron.js";

const wall = (y: number, m: number, d: number, h: number, mi: number) => ({
  y,
  m,
  d,
  h,
  mi,
});

describe("instantsForWallClock", () => {
  it("resolves zones beyond ±2h of UTC (regression: returned [] before)", () => {
    // 09:00 in Taipei (UTC+8, no DST) is 01:00 UTC the same day.
    const taipei = instantsForWallClock(wall(2026, 1, 15, 9, 0), "Asia/Taipei");
    expect(taipei.map((d) => d.toISOString())).toEqual([
      "2026-01-15T01:00:00.000Z",
    ]);

    // 08:30 in New York in winter (EST, UTC-5) is 13:30 UTC.
    const ny = instantsForWallClock(
      wall(2026, 1, 5, 8, 30),
      "America/New_York",
    );
    expect(ny.map((d) => d.toISOString())).toEqual([
      "2026-01-05T13:30:00.000Z",
    ]);
  });

  it("applies the summer offset in DST zones", () => {
    // 08:30 in New York in summer (EDT, UTC-4) is 12:30 UTC.
    const ny = instantsForWallClock(
      wall(2026, 7, 6, 8, 30),
      "America/New_York",
    );
    expect(ny.map((d) => d.toISOString())).toEqual([
      "2026-07-06T12:30:00.000Z",
    ]);
  });

  it("returns no instant for a spring-forward gap wall-clock", () => {
    // US DST starts 2026-03-08: 02:00–03:00 EST does not exist.
    const gap = instantsForWallClock(
      wall(2026, 3, 8, 2, 30),
      "America/New_York",
    );
    expect(gap).toEqual([]);
  });

  it("returns both instants for a fall-back overlap wall-clock", () => {
    // US DST ends 2026-11-01: 01:30 occurs at 05:30Z (EDT) and 06:30Z (EST).
    const twice = instantsForWallClock(
      wall(2026, 11, 1, 1, 30),
      "America/New_York",
    );
    expect(twice.map((d) => d.toISOString())).toEqual([
      "2026-11-01T05:30:00.000Z",
      "2026-11-01T06:30:00.000Z",
    ]);
  });
});

describe("nextOccurrence", () => {
  it("fires daily jobs in far-offset zones (regression: was null forever)", () => {
    const next = nextOccurrence(
      "0 9 * * *",
      "Asia/Taipei",
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(next?.toISOString()).toBe("2026-01-01T01:00:00.000Z");

    const nyWinter = nextOccurrence(
      "30 8 * * *",
      "America/New_York",
      new Date("2026-01-05T00:00:00Z"),
    );
    expect(nyWinter?.toISOString()).toBe("2026-01-05T13:30:00.000Z");

    const nySummer = nextOccurrence(
      "30 8 * * *",
      "America/New_York",
      new Date("2026-07-06T00:00:00Z"),
    );
    expect(nySummer?.toISOString()).toBe("2026-07-06T12:30:00.000Z");
  });

  it("skips a spring-forward gap to the next day (§17.2)", () => {
    const next = nextOccurrence(
      "30 2 * * *",
      "America/New_York",
      new Date("2026-03-08T00:00:00Z"),
    );
    // 02:30 does not exist on 2026-03-08; next real 02:30 is the 9th (EDT).
    expect(next?.toISOString()).toBe("2026-03-09T06:30:00.000Z");
  });

  it("double-fires a fall-back overlap wall minute (§17.2)", () => {
    const first = nextOccurrence(
      "30 1 * * *",
      "America/New_York",
      new Date("2026-11-01T00:00:00Z"),
    );
    expect(first?.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    const second = nextOccurrence("30 1 * * *", "America/New_York", first!);
    expect(second?.toISOString()).toBe("2026-11-01T06:30:00.000Z");
  });
});
