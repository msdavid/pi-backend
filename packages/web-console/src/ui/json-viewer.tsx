import { useMemo, useState } from "react";

import { cx } from "./cx.js";
import styles from "./json-viewer.module.css";

export interface JsonViewerProps {
  value: unknown;
  /** What this payload is, shown next to the summary (e.g. "tool input"). */
  label?: string;
}

/**
 * Collapsed-by-default JSON payload (DP-2: traces are megabytes of nested
 * JSON — never render what wasn't asked for). The pretty-printed text is
 * produced lazily, only once the user expands, and the full subtree is not
 * in the DOM while collapsed.
 */
export function JsonViewer({ value, label = "JSON" }: JsonViewerProps) {
  const [expanded, setExpanded] = useState(false);

  // Lazy: stringification of a large payload happens on first expand only.
  const text = useMemo(
    () => (expanded ? stringify(value) : null),
    [expanded, value],
  );

  return (
    <div className={styles.viewer}>
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <svg
          viewBox="0 0 16 16"
          width="10"
          height="10"
          aria-hidden="true"
          className={cx(styles.chevron, expanded && styles.open)}
        >
          <path d="M5 3l6 5-6 5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        <span className={styles.label}>{label}</span>
        <span className={styles.summary}>{summarize(value)}</span>
      </button>
      {expanded ? <pre className={styles.payload}>{text}</pre> : null}
    </div>
  );
}

/** One-line shape summary shown while collapsed. */
export function summarize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[…] ${value.length} ${value.length === 1 ? "item" : "items"}`;
  }
  if (value !== null && typeof value === "object") {
    const n = Object.keys(value).length;
    return `{…} ${n} ${n === 1 ? "key" : "keys"}`;
  }
  const text = stringify(value);
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "undefined";
  } catch {
    // Circular or otherwise non-serializable — trace payloads off the wire
    // never are, but a component must not throw over it.
    return "[unserializable value]";
  }
}
