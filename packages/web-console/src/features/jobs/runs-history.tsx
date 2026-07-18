/**
 * Runs history for one job (WP-C2.4; W7): newest first, outcome in the
 * shared lifecycle vocabulary, trigger origin (manual vs schedule), and a
 * per-run deep link to the session it started (§7.6).
 */
import type { JobRun } from "@pi-managed/contracts";

import { useJobRuns } from "../../api/jobs.js";
import { Button } from "../../ui/button.js";
import { EmptyState } from "../../ui/empty-state.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { Table, type Column } from "../../ui/table.js";
import { formatTimestamp } from "../sessions/format.js";
import { SessionId } from "../sessions/session-id.js";
import { RunOutcome } from "./run-outcome.js";
import styles from "./job-detail.module.css";

const RUN_COLUMNS: Array<Column<JobRun>> = [
  {
    key: "scheduledAt",
    header: "Scheduled",
    render: (run) => formatTimestamp(run.scheduledAt),
  },
  {
    key: "triggeredAt",
    header: "Triggered",
    render: (run) => formatTimestamp(run.triggeredAt),
  },
  {
    key: "outcome",
    header: "Outcome",
    render: (run) => <RunOutcome run={run} />,
  },
  {
    key: "trigger",
    header: "Trigger",
    render: (run) => (run.manual ? "manual" : "schedule"),
  },
  {
    key: "session",
    header: "Session",
    render: (run) =>
      run.sessionId ? <SessionId id={run.sessionId} maxLength={26} /> : "—",
  },
];

export function RunsHistory({ jobId }: { jobId: string }) {
  const runs = useJobRuns(jobId);
  const rows = runs.data?.pages.flatMap((page) => page.data) ?? [];

  if (runs.isError) return <ErrorAlert label="runs" error={runs.error} />;
  if (runs.isPending) return <p role="status">Loading runs…</p>;

  return (
    <>
      <Table
        columns={RUN_COLUMNS}
        rows={rows}
        rowKey={(run) => run.id}
        caption="Job runs"
        empty={
          <EmptyState
            title="No runs yet"
            description="Every scheduled or manual trigger is recorded here, with the session it started."
          />
        }
      />
      {runs.hasNextPage ? (
        <div className={styles.more}>
          <Button
            onClick={() => void runs.fetchNextPage()}
            disabled={runs.isFetchingNextPage}
          >
            {runs.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
    </>
  );
}
