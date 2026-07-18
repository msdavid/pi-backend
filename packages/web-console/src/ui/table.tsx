import { useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { cx } from "./cx.js";
import styles from "./table.module.css";

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  align?: "left" | "right";
}

export interface TableProps<T> {
  columns: Array<Column<T>>;
  rows: T[];
  /** Stable key per row (typically the resource id). */
  rowKey: (row: T) => string;
  /** Accessible summary of the table (visually hidden caption). */
  caption: string;
  /**
   * When set, rows become interactive: click, or focus a row (roving
   * tabindex, Arrow Up/Down to move) and press Enter/Space (DP-13).
   */
  onRowActivate?: (row: T) => void;
  /** Rendered instead of the table when there are no rows (pair with EmptyState, DP-5). */
  empty?: ReactNode;
}

/**
 * Semantic, dense data table (DP-3: tables over cards; type hierarchy over
 * boxes). Generic over the row type; column rendering is caller-supplied.
 */
export function Table<T>({
  columns,
  rows,
  rowKey,
  caption,
  onRowActivate,
  empty,
}: TableProps<T>) {
  // Roving tabindex over body rows when they are interactive.
  const [focusIndex, setFocusIndex] = useState(0);
  const rowRefs = useRef<Array<HTMLTableRowElement | null>>([]);

  if (rows.length === 0 && empty !== undefined) {
    return <>{empty}</>;
  }

  function moveFocus(index: number) {
    const clamped = Math.max(0, Math.min(rows.length - 1, index));
    setFocusIndex(clamped);
    rowRefs.current[clamped]?.focus();
  }

  function onRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, index: number) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveFocus(index + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveFocus(index - 1);
        break;
      case "Enter":
      case " ": {
        event.preventDefault();
        const row = rows[index];
        if (row !== undefined) onRowActivate?.(row);
        break;
      }
      default:
        break;
    }
  }

  return (
    // §10.5: the table scrolls inside its own named, focusable container so
    // a narrow viewport never scrolls the page sideways (table.module.css).
    // role="group" (not "region"): several screens already wrap a table in a
    // labelled <section> of the same name — a second landmark would be a
    // duplicate announcement.
    <div
      className={styles.scroll}
      role="group"
      aria-label={caption}
      tabIndex={0}
    >
      <table className={styles.table}>
        <caption className={styles.caption}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cx(
                  styles.th,
                  column.align === "right" && styles.right,
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const interactive = onRowActivate !== undefined;
            return (
              <tr
                key={rowKey(row)}
                ref={(el) => {
                  rowRefs.current[index] = el;
                }}
                className={cx(styles.tr, interactive && styles.interactive)}
                tabIndex={
                  interactive ? (index === focusIndex ? 0 : -1) : undefined
                }
                onClick={interactive ? () => onRowActivate(row) : undefined}
                onKeyDown={
                  interactive ? (e) => onRowKeyDown(e, index) : undefined
                }
                onFocus={interactive ? () => setFocusIndex(index) : undefined}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cx(
                      styles.td,
                      column.align === "right" && styles.right,
                    )}
                  >
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
