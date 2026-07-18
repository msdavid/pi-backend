/**
 * A job run's outcome in the shared lifecycle vocabulary (WP-C2.4): completed
 * / failed chip, with the api-reference §17.4 error taxonomy value alongside
 * when the run failed. Used by the list's last-run column and the detail's
 * runs history.
 */
import type { JobRun } from "@pi-managed/contracts";

import { StatusChip } from "../../ui/status-chip.js";
import styles from "./jobs.module.css";

export function RunOutcome({ run }: { run: JobRun }) {
  return (
    <span className={styles.outcome}>
      <StatusChip status={run.error ? "failed" : "completed"} />
      {run.error ? (
        <span className={styles.outcomeError}>{run.error.type}</span>
      ) : null}
    </span>
  );
}
