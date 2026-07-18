import type { ReactNode } from "react";

import { useCopy } from "./use-copy.js";
import styles from "./empty-state.module.css";

export interface EmptyStateProps {
  /** What's missing, stated plainly ("No sessions yet"). */
  title: string;
  /** One line of microcopy explaining the concept (DP-6). */
  description?: string;
  /**
   * The equivalent CLI command (DP-5: every empty list teaches the create
   * flow AND the CLI path), e.g. `pi remote session new`.
   */
  cliCommand?: string;
  /** Create-flow actions (typically a primary <Button>). */
  children?: ReactNode;
}

/** Teaching empty state (DP-5): create flow + the equivalent CLI command. */
export function EmptyState({
  title,
  description,
  cliCommand,
  children,
}: EmptyStateProps) {
  const { copied, copy } = useCopy();

  return (
    <section className={styles.empty}>
      <h2 className={styles.title}>{title}</h2>
      {description ? <p className={styles.description}>{description}</p> : null}
      {children ? <div className={styles.actions}>{children}</div> : null}
      {cliCommand ? (
        <div className={styles.cli}>
          <span className={styles.cliLabel}>Or from the CLI:</span>
          <code className={styles.command}>{cliCommand}</code>
          <button
            type="button"
            className={styles.copy}
            aria-label={`Copy command: ${cliCommand}`}
            onClick={() => void copy(cliCommand)}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
