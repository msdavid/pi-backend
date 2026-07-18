import { cx } from "./cx.js";
import styles from "./status-chip.module.css";

/**
 * ONE lifecycle vocabulary for every resource (tmp/console.md §4): session
 * status, stop reason, job state, run outcome, credential validity and
 * resource archival all map onto the same five tones. Semantic color is
 * reserved for status — nothing else in the console uses these tokens.
 */
export type StatusTone =
  | "neutral"
  | "running"
  | "success"
  | "warning"
  | "danger";

const TONE_BY_STATUS: Record<string, StatusTone> = {
  // live / in progress (accent)
  running: "running",
  rescheduling: "running",
  // healthy / terminal-success
  active: "success",
  completed: "success",
  satisfied: "success",
  valid: "success",
  // needs a human, or ended before its goal
  requires_action: "warning",
  budget_exhausted: "warning",
  needs_revision: "warning",
  max_iterations_reached: "warning",
  paused: "warning",
  interrupted: "warning",
  user_interrupt: "warning",
  // failed outright
  failed: "danger",
  error: "danger",
  invalid: "danger",
  // dormant / terminal-neutral
  idle: "neutral",
  archived: "neutral",
  terminated: "neutral",
  unknown: "neutral",
};

/** Tone for a lifecycle status string; unrecognized statuses are neutral. */
export function statusTone(status: string): StatusTone {
  return TONE_BY_STATUS[status] ?? "neutral";
}

export interface StatusChipProps {
  /** The API's status token, rendered verbatim (same vocabulary as the CLI). */
  status: string;
}

export function StatusChip({ status }: StatusChipProps) {
  return (
    <span className={cx(styles.chip, styles[statusTone(status)])}>
      {status}
    </span>
  );
}
