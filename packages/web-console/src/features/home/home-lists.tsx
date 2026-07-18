/**
 * Presentational lists for Home (§7.2), split out of `home.lazy.tsx` to keep
 * the route component inside the size guideline: the session lists, the
 * per-browser shortcut list, and the truncation-honesty note. Shares
 * `home.module.css` with the route component.
 */
import { Link } from "@tanstack/react-router";
import type { Session } from "@pi-managed/contracts";

import type { SessionShortcut } from "../../lib/session-shortcuts.js";
import { StatusChip } from "../../ui/status-chip.js";
import { SessionId } from "../sessions/session-id.js";
import styles from "./home.module.css";

export function SessionList({
  sessions,
  showStopReason = false,
}: {
  sessions: Session[];
  showStopReason?: boolean;
}) {
  return (
    <ul className={styles.list}>
      {sessions.map((s) => (
        <li key={s.id} className={styles.item}>
          <SessionId id={s.id} />
          <span className={styles.itemTitle}>{s.title ?? "(untitled)"}</span>
          <StatusChip
            status={
              showStopReason && s.stopReason ? s.stopReason : s.status
            }
          />
        </li>
      ))}
    </ul>
  );
}

export function ShortcutList({ shortcuts }: { shortcuts: SessionShortcut[] }) {
  return (
    <ul className={styles.list}>
      {shortcuts.map((s) => (
        <li key={s.id} className={styles.item}>
          <SessionId id={s.id} />
          {s.title ? (
            <Link
              to="/sessions/$sessionId"
              params={{ sessionId: s.id }}
              className={styles.itemLink}
            >
              {s.title}
            </Link>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Truncation honesty: the section scanned only the first page — say so. */
export function TruncationNote({ scanned }: { scanned: string }) {
  return (
    <p className={styles.muted}>
      Showing matches from the {scanned} only — more exist.{" "}
      <Link to="/sessions" className={styles.viewAll}>
        View all in Sessions
      </Link>
    </p>
  );
}
