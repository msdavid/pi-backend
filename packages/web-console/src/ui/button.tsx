import type { ButtonHTMLAttributes } from "react";

import { cx } from "./cx.js";
import styles from "./button.module.css";

export type ButtonVariant = "primary" | "secondary" | "destructive";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * "primary" = accent (one per view), "secondary" = default outline,
   * "destructive" = danger solid (pair with TypedConfirmDialog for DP-7).
   */
  variant?: ButtonVariant;
}

export function Button({
  variant = "secondary",
  type = "button",
  className,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(styles.button, styles[variant], className)}
      {...rest}
    />
  );
}
