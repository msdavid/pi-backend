import { useId } from "react";
import type { ReactNode, SelectHTMLAttributes } from "react";

import { cx } from "./cx.js";
import styles from "./select.module.css";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** Visible label, always rendered and associated (DP-13). */
  label: string;
  /** One line of microcopy under the field (DP-6). */
  hint?: string;
  /** The `<option>` elements. */
  children: ReactNode;
}

/**
 * Native, always-labeled `<select>` (mirrors `Input`). Used for enum filters
 * — session status, trace event type (console-spec §7.3–§7.4) — where the
 * value set is small and known.
 */
export function Select({
  label,
  hint,
  id,
  className,
  children,
  ...rest
}: SelectProps) {
  const autoId = useId();
  const selectId = id ?? autoId;
  const hintId = `${selectId}-hint`;

  return (
    <div className={cx(styles.field, className)}>
      <label className={styles.label} htmlFor={selectId}>
        {label}
      </label>
      <select
        id={selectId}
        className={styles.select}
        aria-describedby={hint ? hintId : undefined}
        {...rest}
      >
        {children}
      </select>
      {hint ? (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
