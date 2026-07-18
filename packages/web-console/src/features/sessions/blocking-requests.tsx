/**
 * Blocking-request panel (WP-C2.2; console-spec §7.5, W4 step 2 — split out
 * of `./interact-panel.tsx` to keep both files inside the component size
 * guideline; shares its CSS module). While the session is idle on
 * `stopReason: requires_action`, the pending tool request(s) — resolved from
 * the trace's last `session.status_idle.blockingEventIds` — render with tool
 * name + collapsed input (DP-2) and Approve / Deny posting
 * `user.tool_confirmation` per blocking event id (§9.5).
 */
import { useSendSessionEvent } from "../../api/session-events.js";
import { useSessionEntries } from "../../api/sessions.js";
import type { SessionEntryWire } from "../../api/sessions.js";
import { Button } from "../../ui/button.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { JsonViewer } from "../../ui/json-viewer.js";
import { useToast } from "../../ui/toast.js";
import { ENTRY_LIMIT } from "./trace-tab.js";
import styles from "./interact-panel.module.css";

/** The one scope note every disabled W4 control points at (§6.1). Rendered
 * by `./interact-panel.tsx`; referenced from both files' `aria-describedby`. */
export const SCOPE_NOTE_ID = "interact-scope-note";

/** The types a blocking event id can point at (tool requests, §9.4–§9.5). */
const BLOCKING_REQUEST_TYPES = new Set([
  "agent.tool_use",
  "agent.mcp_tool_use",
  "agent.custom_tool_use",
]);

/** The blocking event ids of the LAST `requires_action` stop in the slice. */
function blockingEventIds(entries: SessionEntryWire[]): string[] {
  const stop = [...entries]
    .reverse()
    .find(
      (e) =>
        e.type === "session.status_idle" &&
        (e as Record<string, unknown>).stopReason === "requires_action",
    );
  const ids = stop ? (stop as Record<string, unknown>).blockingEventIds : null;
  return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
}

/**
 * W4 step 2: the blocking tool request(s), each with Approve / Deny posting
 * `user.tool_confirmation` (§9.5: `decision: allow | deny`, one per blocking
 * event id). Reads the same entries slice as the Trace tab (shared cache).
 */
export function BlockingRequests({
  sessionId,
  writable,
}: {
  sessionId: string;
  writable: boolean;
}) {
  const entries = useSessionEntries(sessionId, { limit: ENTRY_LIMIT });
  const confirm = useSendSessionEvent(sessionId);
  const { toast } = useToast();

  function decide(eventId: string, decision: "allow" | "deny") {
    confirm.mutate(
      { type: "user.tool_confirmation", eventId, decision },
      {
        onSuccess: () =>
          toast({
            message:
              decision === "allow"
                ? "Approved — the session resumes"
                : "Denied — the tool call is rejected and the session resumes",
            tone: "success",
          }),
      },
    );
  }

  const ids = entries.data ? blockingEventIds(entries.data.data) : [];

  return (
    <div role="group" aria-label="Blocking requests" className={styles.blocking}>
      <p className={styles.blockingLead}>
        Waiting on you — a permission policy stopped this session before
        running a tool (approve or deny to resume it).
      </p>
      {entries.isPending ? <p role="status">Loading blocking request…</p> : null}
      {entries.isError ? (
        <ErrorAlert label="blocking request" error={entries.error} />
      ) : null}
      {entries.isSuccess && ids.length === 0 ? (
        <p className={styles.blockingLead}>
          The pending request is not in the loaded trace slice — see the Trace
          tab for the full log.
        </p>
      ) : null}
      {ids.map((id) => (
        <BlockingRequest
          key={id}
          eventId={id}
          entry={entries.data?.data.find(
            (e) =>
              BLOCKING_REQUEST_TYPES.has(e.type) &&
              (e as Record<string, unknown>).eventId === id,
          )}
          writable={writable}
          pending={confirm.isPending}
          onDecide={decide}
        />
      ))}
      {confirm.isError ? (
        <ErrorAlert label="tool confirmation" error={confirm.error} />
      ) : null}
    </div>
  );
}

function BlockingRequest({
  eventId,
  entry,
  writable,
  pending,
  onDecide,
}: {
  eventId: string;
  entry: SessionEntryWire | undefined;
  writable: boolean;
  pending: boolean;
  onDecide: (eventId: string, decision: "allow" | "deny") => void;
}) {
  const tool = entry ? (entry as Record<string, unknown>).tool : undefined;
  const disabled = !writable || pending;
  return (
    <div className={styles.request}>
      <div className={styles.requestFacts}>
        {typeof tool === "string" ? (
          <span>
            <span className={styles.requestLabel}>tool</span>{" "}
            <code className={styles.requestTool}>{tool}</code>
          </span>
        ) : (
          // The blocking id points outside the loaded slice — still
          // answerable (the confirmation only needs the event id).
          <span>
            <span className={styles.requestLabel}>blocking event</span>{" "}
            <code className={styles.requestTool}>{eventId}</code>
          </span>
        )}
        {entry ? (
          <JsonViewer
            label="input"
            value={(entry as Record<string, unknown>).input}
          />
        ) : null}
      </div>
      <span className={styles.requestActions}>
        <Button
          variant="primary"
          disabled={disabled}
          aria-describedby={writable ? undefined : SCOPE_NOTE_ID}
          onClick={() => onDecide(eventId, "allow")}
        >
          Approve
        </Button>
        <Button
          disabled={disabled}
          aria-describedby={writable ? undefined : SCOPE_NOTE_ID}
          onClick={() => onDecide(eventId, "deny")}
        >
          Deny
        </Button>
      </span>
    </div>
  );
}
