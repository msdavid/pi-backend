/**
 * POSIX cron parser + IANA timezone "literal wall-clock" occurrence resolver
 * (WP-2.1, §17.2).
 *
 * 5 fields: minute hour day-of-month month day-of-week. Max granularity minute.
 *
 * **Literal wall-clock matching (§17.2):** the cron fields are matched against
 * the wall-clock time in the configured IANA timezone, NOT against a UTC
 * instant. DST transitions are handled per the spec:
 *  - **Spring-forward (gap):** a wall-clock time that does not exist (e.g.
 *    02:30 on the spring-forward day in `America/New_York`) is simply never
 *    matched — no occurrence is produced for it.
 *  - **Fall-back (overlap):** a wall-clock time that occurs twice (e.g. 01:30
 *    on the fall-back day) fires TWICE — once for each UTC instant that maps to
 *    that wall-clock. {@link nextOccurrence} returns these as two successive
 *    occurrences (the second is returned when called with `after` = the first).
 *
 * Jitter (§17.2, ≤10s) is a trigger-time concern, not an occurrence-time
 * concern: the scheduled occurrence is the exact wall-clock minute, and
 * exactly-once is keyed on it (§17.8). {@link JITTER_MAX_MS} + {@link jitterMs}
 * are exported for the tick loop to optionally delay claiming.
 */

/** Max scheduler jitter, in ms (§17.2 "≤10s"). */
export const JITTER_MAX_MS = 10_000;

/** A random jitter delay in [0, JITTER_MAX_MS] (§17.2). */
export function jitterMs(max: number = JITTER_MAX_MS): number {
  return Math.floor(Math.random() * (max + 1));
}

// ---------------------------------------------------------------------------
// Wall-clock components in an IANA timezone
// ---------------------------------------------------------------------------

/** Wall-clock minute components (proleptic Gregorian; 1-indexed month/day). */
export interface WallClock {
  y: number;
  /** 1–12. */
  m: number;
  /** 1–31. */
  d: number;
  /** 0–23. */
  h: number;
  /** 0–59. */
  mi: number;
}

/** Format cache per timezone (Intl formatters are expensive to construct). */
const tzFormatters = new Map<string, Intl.DateTimeFormat>();

function tzFormatter(tz: string): Intl.DateTimeFormat {
  let f = tzFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    tzFormatters.set(tz, f);
  }
  return f;
}

/** Parse the parts bag from an Intl formatter into a WallClock. */
function partsToWall(parts: Intl.DateTimeFormatPart[]): WallClock {
  const get = (type: string): string => {
    const p = parts.find((p) => p.type === type);
    return p ? p.value : "";
  };
  let h = parseInt(get("hour"), 10);
  if (h === 24) h = 0; // some engines emit "24" at midnight with hour12:false
  return {
    y: parseInt(get("year"), 10),
    m: parseInt(get("month"), 10),
    d: parseInt(get("day"), 10),
    h,
    mi: parseInt(get("minute"), 10),
  };
}

/**
 * The wall-clock minute of `instant` as seen in `tz`, truncated to the minute.
 * Authoritative for cron field matching (§17.2 literal wall-clock).
 */
export function wallOf(instant: Date, tz: string): WallClock {
  return partsToWall(tzFormatter(tz).formatToParts(instant));
}

// ---------------------------------------------------------------------------
// Calendar arithmetic on WallClock (wall-clock, not UTC)
// ---------------------------------------------------------------------------

/** Days in a (Gregorian) month; `m` is 1–12. */
function daysInMonth(y: number, m: number): number {
  if (m === 2) {
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    return leap ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

/** Day-of-week of a Gregorian date, 0=Sunday … 6=Saturday (POSIX). */
function dowOf(y: number, m: number, d: number): number {
  // Date.UTC gives a UTC instant whose UTC weekday is the Gregorian weekday.
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Advance a wall-clock by one minute, carrying into hours/days/months/years.
 * Pure wall-clock arithmetic (no DST awareness) — exactly what literal matching
 * requires.
 */
function addMinute(w: WallClock): WallClock {
  let { y, m, d, h, mi } = w;
  mi += 1;
  if (mi < 60) return { y, m, d, h, mi };
  mi = 0;
  h += 1;
  if (h < 24) return { y, m, d, h, mi };
  h = 0;
  d += 1;
  if (d <= daysInMonth(y, m)) return { y, m, d, h, mi };
  d = 1;
  m += 1;
  if (m <= 12) return { y, m, d, h, mi };
  m = 1;
  y += 1;
  return { y, m, d, h, mi };
}

// ---------------------------------------------------------------------------
// Cron field parsing
// ---------------------------------------------------------------------------

/** A parsed cron field: a set of allowed values + whether it was a wildcard. */
interface Field {
  values: Set<number>;
  wildcard: boolean;
}

const FIELD_RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week (0=Sunday); 7 normalized to 0
];

/** Parse a single cron field token into a set of ints. */
function parseField(token: string, idx: number): Field {
  const [min, max] = FIELD_RANGES[idx];
  const out = new Set<number>();
  if (token === "*") {
    for (let v = min; v <= max; v++) out.add(v);
    return { values: out, wildcard: true };
  }
  for (const part of token.split(",")) {
    if (part === "") {
      throw new Error(`empty list element in cron field ${idx + 1}`);
    }
    let step = 1;
    const slashIdx = part.indexOf("/");
    let range = part;
    if (slashIdx >= 0) {
      step = parseInt(part.slice(slashIdx + 1), 10);
      if (!Number.isFinite(step) || step < 1) {
        throw new Error(`invalid step in cron field ${idx + 1}: ${part}`);
      }
      range = part.slice(0, slashIdx);
    }
    let lo: number, hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      lo = parseInt(a, 10);
      hi = parseInt(b, 10);
    } else {
      lo = parseInt(range, 10);
      hi = slashIdx >= 0 ? max : lo; // "5/2" → from 5 to max step 2
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      throw new Error(`invalid value in cron field ${idx + 1}: ${part}`);
    }
    // dow 7 → 0 (Sunday). Only relevant for field 4.
    if (idx === 4) {
      if (lo === 7) lo = 0;
      if (hi === 7) hi = 0;
    }
    if (lo < min || hi > max || lo > hi) {
      throw new Error(`out-of-range value in cron field ${idx + 1}: ${part}`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return { values: out, wildcard: false };
}

/** Parsed 5-field POSIX cron expression. */
export interface ParsedCron {
  minute: Field;
  hour: Field;
  dom: Field;
  month: Field;
  dow: Field;
}

/**
 * Parse a 5-field POSIX cron expression. Throws on malformed input. `*`, ranges
 * (`1-5`), lists (`1,3,5`), and steps (`1-30/2`, `0-59/10`) are supported.
 */
export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `cron expression must have exactly 5 fields (got ${fields.length}): ${expr}`,
    );
  }
  return {
    minute: parseField(fields[0], 0),
    hour: parseField(fields[1], 1),
    dom: parseField(fields[2], 2),
    month: parseField(fields[3], 3),
    dow: parseField(fields[4], 4),
  };
}

/**
 * Whether a wall-clock matches the cron fields, applying the POSIX rule for
 * day-of-month / day-of-week interaction: if BOTH are restricted (non-`*`),
 * a match on EITHER fires; if only one is restricted, that one must match.
 */
function matches(w: WallClock, c: ParsedCron): boolean {
  if (!c.month.values.has(w.m)) return false;
  if (!c.minute.values.has(w.mi)) return false;
  if (!c.hour.values.has(w.h)) return false;
  const domMatch = c.dom.values.has(w.d);
  const dowMatch = c.dow.values.has(dowOf(w.y, w.m, w.d));
  const bothRestricted = !c.dom.wildcard && !c.dow.wildcard;
  if (bothRestricted) return domMatch || dowMatch;
  return domMatch && dowMatch;
}

// ---------------------------------------------------------------------------
// Wall-clock → UTC instant resolution (the DST-correct core)
// ---------------------------------------------------------------------------

/**
 * All UTC instants (0, 1, or 2) that map to the given wall-clock minute in `tz`.
 *  - 0 during a spring-forward gap (the wall-clock does not exist),
 *  - 1 in the normal case,
 *  - 2 during a fall-back overlap (the wall-clock occurs twice).
 *
 * Found by scanning a ±2h window of UTC minutes and keeping those whose
 * `wallOf` equals the target. The window is centered on the wall-clock shifted
 * by the zone's probed UTC offset at that instant — NOT on the wall-clock
 * naïvely interpreted as UTC: a naïve center puts every zone with
 * |offset| > 2h permanently outside the window, so `nextOccurrence` returned
 * `null` and jobs scheduled in e.g. America/New_York or Asia/Taipei never
 * fired. ±2h around the probed offset still covers DST transitions (offset
 * shifts of ≤ 2h) on either side of the probe.
 */
export function instantsForWallClock(w: WallClock, tz: string): Date[] {
  const base = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi);
  const probe = wallOf(new Date(base), tz);
  const probeMs = Date.UTC(probe.y, probe.m - 1, probe.d, probe.h, probe.mi);
  const center = base - (probeMs - base);
  const out: Date[] = [];
  for (let off = -120; off <= 120; off++) {
    const t = center + off * 60_000;
    const w2 = wallOf(new Date(t), tz);
    if (
      w2.y === w.y &&
      w2.m === w.m &&
      w2.d === w.d &&
      w2.h === w.h &&
      w2.mi === w.mi
    ) {
      out.push(new Date(t));
    }
  }
  out.sort((a, b) => a.getTime() - b.getTime());
  return out;
}

/**
 * The next occurrence of `cron` in `tz` strictly after `after`. Implements the
 * literal wall-clock semantics of §17.2 (spring-forward skip, fall-back
 * double-fire). Returns `null` if none is found within a ~4-year horizon (a
 * safety bound; e.g. `0 0 29 2 *` on a non-leap year recurs within 4 years).
 */
export function nextOccurrence(
  cron: string | ParsedCron,
  tz: string,
  after: Date,
): Date | null {
  const parsed = typeof cron === "string" ? parseCron(cron) : cron;
  const afterMs = after.getTime();

  // Start scanning from the wall-clock minute of `after`. The same wall minute
  // is re-examined because, during a fall-back overlap, a second UTC instant
  // may be > `after`.
  let w = wallOf(after, tz);

  // Safety bound: ~4 years of minutes. In practice the loop exits in minutes.
  const MAX_ITERS = 4 * 366 * 24 * 60;
  for (let i = 0; i < MAX_ITERS; i++) {
    if (matches(w, parsed)) {
      const instants = instantsForWallClock(w, tz);
      for (const inst of instants) {
        if (inst.getTime() > afterMs) return inst;
      }
      // All instants of this wall minute are ≤ `after` (or none exist) → advance.
    }
    w = addMinute(w);
  }
  return null;
}

/**
 * Validate a cron expression + IANA timezone. Throws on invalid input. Used by
 * the job service at creation time so bad input is rejected with 422.
 */
export function validateSchedule(cron: string, tz: string): void {
  parseCron(cron);
  // Intl throws for unknown timezones; format a known instant to probe.
  try {
    tzFormatter(tz).formatToParts(new Date(0));
  } catch {
    throw new Error(`unknown IANA timezone: ${tz}`);
  }
}
