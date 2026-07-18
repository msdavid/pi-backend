/**
 * Trace tab (WP-C1.7 + WP-C2.1; console-spec §7.4, §8.1–§8.2, W2 step 3 /
 * W3): chronological entries from `GET /v1/sessions/:id/entries` with an
 * event-type filter; payloads collapsed by default (DP-2, see
 * `./trace-entry.tsx`).
 *
 * While the session is in a non-terminal status the trace live-tails: the
 * stream itself is owned by the session-detail page (ONE `useSessionStream`
 * per viewed session, independent of the active tab — §8.3 needs the detail
 * cache fresh even while another tab is up), and this tab receives its
 * `streamPhase`. New entries append straight into the entries cache
 * (respecting the active event-type filter — it is applied at render), a
 * polite ARIA live region announces the updates (C§12.2), and a subtle
 * indicator shows where events are coming from — live SSE, the polling
 * fallback, or nothing anymore (stream ended). Auto-scroll follows the tail
 * only while the user is already at the bottom.
 */
import { useEffect, useRef, useState } from "react";

import { useSessionEntries } from "../../api/sessions.js";
import type { UseSessionStreamResult } from "../../api/session-stream.js";
import { Button } from "../../ui/button.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { Select } from "../../ui/select.js";
import { TraceEntry } from "./trace-entry.js";
import styles from "./trace.module.css";

/** v1 parity: one slice of up to 200 entries from the start of the log.
 * Exported so `./interact-panel.tsx` reads the SAME slice (shared cache). */
export const ENTRY_LIMIT = 200;

/** How close to the bottom (px) still counts as "at the bottom" (auto-scroll). */
const AUTOSCROLL_SLACK_PX = 64;

const PHASE_LABEL = {
  connecting: "connecting…",
  live: "live",
  polling: "polling",
  ended: "stream ended",
} as const;

export function TraceTab({
  sessionId,
  streamPhase,
}: {
  sessionId: string;
  /** The detail page's stream state (it owns the single `useSessionStream`). */
  streamPhase: UseSessionStreamResult["phase"];
}) {
  const entries = useSessionEntries(sessionId, { limit: ENTRY_LIMIT });
  const [typeFilter, setTypeFilter] = useState("");
  // Entries can still arrive (auto-scroll cares) unless the stream is off
  // (session terminal / not streaming) or over.
  const streaming = streamPhase !== "idle" && streamPhase !== "ended";

  // Auto-scroll: stick to the tail only while the user is already there.
  const endRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const visibleCount = entries.data
    ? (typeFilter
        ? entries.data.data.filter((e) => e.type === typeFilter)
        : entries.data.data
      ).length
    : 0;
  useEffect(() => {
    const update = (): void => {
      stickRef.current = nearBottom();
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update, { passive: true });
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  useEffect(() => {
    if (!streaming || visibleCount === 0) return;
    if (stickRef.current) endRef.current?.scrollIntoView?.({ block: "end" });
  }, [streaming, visibleCount]);

  if (entries.isError) {
    return (
      <div>
        <ErrorAlert label="events" error={entries.error} />
        <Button onClick={() => void entries.refetch()}>Retry</Button>
      </div>
    );
  }
  if (entries.isPending) {
    return <p role="status">Loading events…</p>;
  }

  const all = entries.data.data;
  // The filter offers exactly the types present in the loaded slice.
  const types = [...new Set(all.map((e) => e.type))].sort();
  const visible = typeFilter ? all.filter((e) => e.type === typeFilter) : all;

  return (
    <div>
      <div className={styles.toolbar}>
        <Select
          label="Event type"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
        >
          <option value="">all</option>
          {types.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </Select>
        <Button
          onClick={() => void entries.refetch()}
          disabled={entries.isRefetching}
        >
          Refresh
        </Button>
        {/* One element is both the subtle live/polling/ended indicator and
            the polite ARIA live region (C§12.2): its text changes as entries
            stream in, so screen readers hear the trace advancing. */}
        {streamPhase !== "idle" ? (
          <span
            role="status"
            className={styles.streamIndicator}
            data-phase={streamPhase}
          >
            {PHASE_LABEL[streamPhase]}
            {streamPhase === "live" || streamPhase === "polling"
              ? ` — ${all.length} event${all.length === 1 ? "" : "s"}`
              : ""}
          </span>
        ) : null}
      </div>
      {visible.length === 0 ? (
        <p className={styles.empty}>
          {all.length === 0
            ? "No events yet — the trace fills once the session does work."
            : "No events of this type in the loaded slice."}
        </p>
      ) : (
        <ol className={styles.list} aria-label="Session events">
          {visible.map((entry) => (
            <TraceEntry key={entry.seq} entry={entry} />
          ))}
        </ol>
      )}
      <div ref={endRef} aria-hidden="true" />
    </div>
  );
}

/** Whether the viewport currently sits at (or near) the document bottom. */
function nearBottom(): boolean {
  const doc = document.documentElement;
  return (
    window.innerHeight + window.scrollY >= doc.scrollHeight - AUTOSCROLL_SLACK_PX
  );
}
