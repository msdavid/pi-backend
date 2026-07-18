/**
 * One trace entry (WP-C1.7; console-spec §7.4). The head pins the positional
 * facts (`#seq`, type, processedAt); the body renders the event-specific
 * payload with the same per-type mapping the v1 console's renderEntries used
 * (retired in WP-C1.8), except every payload now goes through the collapsed-
 * by-default `JsonViewer` (DP-2). Tool executions are first-class: name, input,
 * output, and the truncation flag.
 */
import type { SessionEntryWire } from "../../api/sessions.js";
import { JsonViewer } from "../../ui/json-viewer.js";
import { formatTimestamp } from "./format.js";
import styles from "./trace.module.css";

/** The event types rendered as a tool invocation (name + input). */
const TOOL_USE_TYPES = new Set([
  "agent.tool_use",
  "agent.mcp_tool_use",
  "agent.custom_tool_use",
]);

function field(entry: SessionEntryWire, key: string): unknown {
  return (entry as Record<string, unknown>)[key];
}

function text(value: unknown): string {
  if (value == null) return "—";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** The event-specific payload: everything but the positional envelope. */
function restPayload(entry: SessionEntryWire): Record<string, unknown> {
  const { seq: _seq, type: _type, processedAt: _at, ...rest } = entry;
  return rest;
}

export function TraceEntry({ entry }: { entry: SessionEntryWire }) {
  return (
    <li className={styles.entry}>
      <div className={styles.head}>
        <span className={styles.seq}>#{entry.seq}</span>
        <span className={styles.type}>{entry.type}</span>
        <span className={styles.time}>
          {formatTimestamp(entry.processedAt)}
        </span>
      </div>
      <div className={styles.body}>
        <EntryBody entry={entry} />
      </div>
    </li>
  );
}

function EntryBody({ entry }: { entry: SessionEntryWire }) {
  if (TOOL_USE_TYPES.has(entry.type)) {
    return (
      <>
        <FactLine label="tool" value={text(field(entry, "tool"))} />
        <JsonViewer label="input" value={field(entry, "input")} />
      </>
    );
  }
  if (entry.type === "agent.tool_result") {
    return (
      <>
        <FactLine label="tool" value={text(field(entry, "tool"))} />
        <JsonViewer label="output" value={field(entry, "output")} />
        {field(entry, "truncated") === true ? (
          <span className={styles.truncated}>(truncated)</span>
        ) : null}
      </>
    );
  }
  if (entry.type === "session.status_idle") {
    const blocking = field(entry, "blockingEventIds");
    return (
      <>
        <FactLine
          label="stopReason"
          value={text(field(entry, "stopReason"))}
        />
        {Array.isArray(blocking) && blocking.length > 0 ? (
          <FactLine label="blockingEventIds" value={blocking.join(", ")} />
        ) : null}
      </>
    );
  }
  if (entry.type === "session.error") {
    return (
      <>
        <FactLine
          label="mcpServerName"
          value={text(field(entry, "mcpServerName"))}
        />
        <FactLine
          label="retryStatus"
          value={text(field(entry, "retryStatus"))}
        />
      </>
    );
  }
  const content = field(entry, "content");
  if (content != null) {
    return <p className={styles.content}>{text(content)}</p>;
  }
  return <JsonViewer label="payload" value={restPayload(entry)} />;
}

function FactLine({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.fact}>
      <span className={styles.factLabel}>{label}: </span>
      <span>{value}</span>
    </div>
  );
}
