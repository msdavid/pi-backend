/**
 * Display-side cron helpers for the jobs surface (WP-C2.4; W7/DP-1: the list
 * leads with a human-readable schedule and the next fire).
 *
 * Mirrors the backend's parser + "literal wall-clock" occurrence resolver
 * (`packages/backend/src/domain/scheduler/cron.ts`, §17.2: spring-forward
 * skip, fall-back double-fire, POSIX dom/dow either-matches rule). The
 * backend module cannot be imported into a browser bundle (its package
 * barrel pulls in node-only deps), so the few dozen lines are replicated —
 * same precedent as `src/api/__tests__/harness.ts`. This is presentation
 * only: the scheduler remains the single source of truth for firing.
 *
 * Drift guard: `./schedule.contract.test.ts` (node env) pins this replica
 * against the real backend resolver imported from `@pi-managed/backend`, so
 * a one-sided change to either implementation fails a test. The one known,
 * deliberate divergence (the shorter ~2-year scan horizon here) is pinned
 * explicitly there.
 */

// --- Parsing (subset identical to the backend's) -----------------------------

interface Field {
  values: Set<number>;
  wildcard: boolean;
}

interface ParsedCron {
  minute: Field;
  hour: Field;
  dom: Field;
  month: Field;
  dow: Field;
}

const BOUNDS: Array<[min: number, max: number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // dom
  [1, 12], // month
  [0, 7], // dow (7 → 0, Sunday)
];

function parseField(raw: string, idx: number): Field {
  const [min, max] = BOUNDS[idx]!;
  if (raw === "*") {
    const values = new Set<number>();
    for (let v = min; v <= max; v += 1) values.add(v);
    return { values, wildcard: true };
  }
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const slashIdx = part.indexOf("/");
    const range = slashIdx >= 0 ? part.slice(0, slashIdx) : part;
    const step = slashIdx >= 0 ? parseInt(part.slice(slashIdx + 1), 10) : 1;
    if (!Number.isFinite(step) || step < 1) {
      throw new Error(`invalid step in cron field ${idx + 1}: ${part}`);
    }
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      lo = parseInt(a!, 10);
      hi = parseInt(b!, 10);
    } else {
      lo = parseInt(range, 10);
      hi = slashIdx >= 0 ? max : lo;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      throw new Error(`invalid value in cron field ${idx + 1}: ${part}`);
    }
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

function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron expression must have exactly 5 fields: ${expr}`);
  }
  return {
    minute: parseField(fields[0]!, 0),
    hour: parseField(fields[1]!, 1),
    dom: parseField(fields[2]!, 2),
    month: parseField(fields[3]!, 3),
    dow: parseField(fields[4]!, 4),
  };
}

// --- Human-readable description (DP-1 list column) ---------------------------

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function only<T>(set: Set<T>): T | null {
  return set.size === 1 ? [...set][0]! : null;
}

/**
 * A short English phrase for the common cron shapes ("daily at 07:00",
 * "weekdays at 07:00", "every 15 minutes"); anything irregular (or
 * unparsable) falls back to the raw expression — which the UI shows alongside
 * the phrase anyway.
 */
export function describeCron(cron: string): string {
  let c: ParsedCron;
  try {
    c = parseCron(cron);
  } catch {
    return cron;
  }
  const minute = only(c.minute.values);
  const hour = only(c.hour.values);
  if (!c.month.wildcard) return cron;

  const daysPart = (): string | null => {
    if (c.dom.wildcard && c.dow.wildcard) return "daily";
    if (c.dom.wildcard && !c.dow.wildcard) {
      const dow = [...c.dow.values].sort((a, b) => a - b);
      if (dow.join(",") === "1,2,3,4,5") return "weekdays";
      return `on ${dow.map((d) => DAY_NAMES[d]).join(", ")}`;
    }
    if (!c.dom.wildcard && c.dow.wildcard) {
      const dom = only(c.dom.values);
      return dom !== null ? `monthly on day ${dom}` : null;
    }
    return null; // both restricted (POSIX either-matches) — show raw
  };

  if (minute !== null && hour !== null) {
    const days = daysPart();
    if (days === null) return cron;
    return `${days} at ${pad2(hour)}:${pad2(minute)}`;
  }
  if (c.hour.wildcard && c.dom.wildcard && c.dow.wildcard) {
    if (minute !== null) return `hourly at :${pad2(minute)}`;
    if (c.minute.wildcard) return "every minute";
    const minutes = [...c.minute.values].sort((a, b) => a - b);
    const step = minutes.length > 1 ? minutes[1]! - minutes[0]! : 0;
    if (
      step > 0 &&
      minutes[0] === 0 &&
      minutes.every((m, i) => m === i * step)
    ) {
      return `every ${step} minutes`;
    }
  }
  return cron;
}

// --- Client-side validation (WP-C3.5 create form) ----------------------------

/**
 * Validation message for a cron expression, `null` when it parses. Instant
 * feedback for the create form (§9.4) — the parse rules mirror the backend's
 * `validateSchedule`, but the server remains the authority (it re-validates
 * on `POST /v1/jobs` and answers `422`).
 */
export function cronError(expr: string): string | null {
  try {
    parseCron(expr);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/**
 * Validation message for an IANA timezone, `null` when Intl knows it (the
 * same probe the backend uses: constructing a formatter throws on unknown
 * zones).
 */
export function timeZoneError(tz: string): string | null {
  try {
    tzFormatter(tz);
    return null;
  } catch {
    return `unknown IANA timezone: ${tz}`;
  }
}

// --- Next fire (literal wall-clock in the schedule's IANA tz) ----------------

interface WallClock {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
}

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

function wallOf(instant: Date, tz: string): WallClock {
  const parts = tzFormatter(tz).formatToParts(instant);
  const get = (type: string): number =>
    parseInt(parts.find((p) => p.type === type)?.value ?? "", 10);
  let h = get("hour");
  if (h === 24) h = 0; // some engines emit "24" at midnight with hour12:false
  return { y: get("year"), m: get("month"), d: get("day"), h, mi: get("minute") };
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Advance a wall-clock struct by one minute (pure arithmetic — no Intl). */
function addMinute(w: WallClock): WallClock {
  let { y, m, d, h, mi } = w;
  mi += 1;
  if (mi > 59) {
    mi = 0;
    h += 1;
    if (h > 23) {
      h = 0;
      d += 1;
      if (d > daysInMonth(y, m)) {
        d = 1;
        m += 1;
        if (m > 12) {
          m = 1;
          y += 1;
        }
      }
    }
  }
  return { y, m, d, h, mi };
}

function dowOf(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** POSIX dom/dow rule: both restricted → either matches. */
function matches(w: WallClock, c: ParsedCron): boolean {
  if (!c.month.values.has(w.m)) return false;
  if (!c.minute.values.has(w.mi)) return false;
  if (!c.hour.values.has(w.h)) return false;
  const domMatch = c.dom.values.has(w.d);
  const dowMatch = c.dow.values.has(dowOf(w.y, w.m, w.d));
  if (!c.dom.wildcard && !c.dow.wildcard) return domMatch || dowMatch;
  return domMatch && dowMatch;
}

/**
 * UTC instants (0, 1, or 2) mapping to a wall-clock minute in `tz`: 0 during
 * a spring-forward gap, 2 during a fall-back overlap.
 *
 * Unlike the backend original, the ±2h scan window is CENTERED on the zone's
 * probed UTC offset — a window centered on the naive-UTC reading misses every
 * zone whose |offset| exceeds 2h (America/New_York included); ±2h around the
 * probed offset still catches both sides of any real DST transition (≤2h).
 */
function instantsForWallClock(w: WallClock, tz: string): Date[] {
  const base = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi);
  const probe = wallOf(new Date(base), tz);
  const probeMs = Date.UTC(probe.y, probe.m - 1, probe.d, probe.h, probe.mi);
  const center = base - (probeMs - base);
  const out: Date[] = [];
  for (let off = -120; off <= 120; off += 1) {
    const t = new Date(center + off * 60_000);
    const w2 = wallOf(t, tz);
    if (
      w2.y === w.y &&
      w2.m === w.m &&
      w2.d === w.d &&
      w2.h === w.h &&
      w2.mi === w.mi
    ) {
      out.push(t);
    }
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

/** Scan horizon: ~2 years of wall-clock minutes (cheap integer iterations). */
const MAX_ITERS = 2 * 366 * 24 * 60;

/**
 * The next occurrence of `cron` in `tz` strictly after `after` (default:
 * now); `null` when the expression is malformed, the timezone is unknown, or
 * nothing matches within ~2 years.
 */
export function nextFire(
  schedule: { cron: string; tz: string },
  after: Date = new Date(),
): Date | null {
  let parsed: ParsedCron;
  let w: WallClock;
  try {
    parsed = parseCron(schedule.cron);
    w = wallOf(after, schedule.tz);
  } catch {
    return null;
  }
  const afterMs = after.getTime();
  for (let i = 0; i < MAX_ITERS; i += 1) {
    if (matches(w, parsed)) {
      for (const inst of instantsForWallClock(w, schedule.tz)) {
        if (inst.getTime() > afterMs) return inst;
      }
    }
    w = addMinute(w);
  }
  return null;
}
