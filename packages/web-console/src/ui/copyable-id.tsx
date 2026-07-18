import type { ReactNode } from "react";

import { useCopy } from "./use-copy.js";
import styles from "./copyable-id.module.css";

/**
 * Middle-truncate: prefixed ids (`sess_…`, `agent_…`) carry signal at both
 * ends — the prefix says what it is, the tail disambiguates. Keeps roughly
 * 60/40 head/tail around a single ellipsis.
 */
export function truncateMiddle(value: string, max: number): string {
  if (value.length <= max) return value;
  const head = Math.ceil((max - 1) * 0.6);
  const tail = max - 1 - head;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export interface CopyableIdProps {
  /** The full id; always copied whole, truncated only visually. */
  id: string;
  /** Max rendered characters before middle-truncation. */
  maxLength?: number;
  /**
   * Wrap the rendered id in its detail-route link (console-spec §7.6: every
   * id links to its detail route). A render prop, so src/ui stays
   * router-agnostic — feature code supplies the router `<Link>`.
   */
  link?: (id: ReactNode) => ReactNode;
}

/** Prefixed ids are first-class UI: mono, one-click copy (console.md §4). */
export function CopyableId({ id, maxLength = 24, link }: CopyableIdProps) {
  const { copied, copy } = useCopy();

  const code = (
    <code className={styles.id} title={id}>
      {truncateMiddle(id, maxLength)}
    </code>
  );

  return (
    <span className={styles.wrap}>
      {link ? link(code) : code}
      <button
        type="button"
        className={styles.copy}
        aria-label={`Copy ${id}`}
        onClick={(event) => {
          // Ids sit inside interactive table rows (C§7.6 + Table
          // onRowActivate); copying must not also activate the row.
          event.stopPropagation();
          void copy(id);
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
      <span role="status" className={styles.visuallyHidden}>
        {copied ? "Copied" : ""}
      </span>
    </span>
  );
}

/* Inline SVG icons only — no asset requests, ever (console-spec §3.4). */

function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <rect
        x="5.5"
        y="5.5"
        width="8"
        height="8"
        rx="1.5"
        fill="none"
        stroke="currentColor"
      />
      <path
        d="M10.5 3.5v-1a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1"
        fill="none"
        stroke="currentColor"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        d="M3 8.5 6.5 12 13 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}
