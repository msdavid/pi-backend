import { useId } from "react";
import type { InputHTMLAttributes, ReactNode } from "react";

import { cx } from "./cx.js";
import styles from "./input.module.css";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Visible label, always rendered and associated (DP-13). */
  label: string;
  /** Validation error; sets aria-invalid and is announced via description.
   * A node so callers can include a link (e.g. the DP-9 docs link). */
  error?: ReactNode;
  /** One line of microcopy under the field (DP-6). */
  hint?: string;
}

export function Input({ label, error, hint, id, className, ...rest }: InputProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;
  const describedBy =
    cx(error ? errorId : undefined, hint ? hintId : undefined) || undefined;

  return (
    <div className={cx(styles.field, className)}>
      <label className={styles.label} htmlFor={inputId}>
        {label}
      </label>
      <input
        id={inputId}
        className={cx(styles.input, error ? styles.invalid : undefined)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
      />
      {hint ? (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className={styles.error}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
