import type { Clock, Scheduler } from "@pi-managed/backend";

/**
 * Injectable fake `Clock` (spec §17.8) with `advance` for deterministic time. Use to
 * test DST skip/double-fire and catch-up windows without waiting.
 */
export class FakeClock implements Clock {
  private current: Date;

  constructor(initial: Date = new Date("2026-01-01T00:00:00Z")) {
    this.current = initial;
  }

  now(): Date {
    return this.current;
  }

  /** Advance the clock by `ms` milliseconds. */
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  /** Jump to an explicit time. */
  set(date: Date): void {
    this.current = date;
  }
}

/**
 * Fake `Scheduler` (spec §17.8). Records ticks; does no real cron math. Tests script
 * `setDue` to control whether the next tick fires jobs. Exactly-once is the real impl's
 * concern (Postgres unique constraint), not the fake's.
 */
export class FakeScheduler implements Scheduler {
  readonly ticks = 0;
  private due = false;
  /** Set whether the next `tick()` should act as if jobs are due. */
  private onTick: (() => Promise<void>) | undefined;

  setDue(due: boolean): void {
    this.due = due;
  }

  /** Install a side-effect to run when `tick()` finds due jobs. */
  onTickRun(fn: () => Promise<void>): void {
    this.onTick = fn;
  }

  async tick(): Promise<void> {
    (this as { ticks: number }).ticks += 1;
    if (this.due && this.onTick) {
      await this.onTick();
    }
  }
}
