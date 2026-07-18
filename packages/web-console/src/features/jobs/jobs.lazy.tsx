/**
 * Jobs list (WP-C2.4 + WP-C3.5; console-spec §9.4, journey W7): the DP-1
 * decisive facts as columns — name, schedule (human-readable phrase + raw
 * cron), status, last-run outcome, next fire. Browsing is all-scopes; the
 * "New job" action (admin, `./create-job.tsx`) opens the §9.4 create form.
 * Pause/unpause/archive live on the detail page (`./job-lifecycle.tsx`).
 */
import { createLazyRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { Job, JobStatus } from "@pi-managed/contracts";

import { useJobLastRun, useJobs } from "../../api/jobs.js";
import { Button } from "../../ui/button.js";
import { EmptyState } from "../../ui/empty-state.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { Select } from "../../ui/select.js";
import { StatusChip } from "../../ui/status-chip.js";
import { Table, type Column } from "../../ui/table.js";
import { formatTimestamp } from "../sessions/format.js";
import { CreateJobAction } from "./create-job.js";
import { RunOutcome } from "./run-outcome.js";
import { describeCron, nextFire } from "./schedule.js";
import styles from "./jobs.module.css";

export const Route = createLazyRoute("/jobs")({
  component: JobsPage,
});

// No "archived" option: archive is terminal AND hides the job from every
// read — the backend's list always excludes archived rows and detail/runs
// 404 (job-service.ts §17.5; pinned by jobs-lifecycle.contract.test.ts), so
// the filter would only ever produce an empty list.
const STATUSES: JobStatus[] = ["active", "paused"];

const COLUMNS: Array<Column<Job>> = [
  {
    key: "name",
    header: "Name",
    render: (job) => (
      <span className={styles.name}>
        {job.name}
        {job.oneShot ? <span className={styles.oneShot}>one-shot</span> : null}
      </span>
    ),
  },
  {
    key: "schedule",
    header: "Schedule",
    render: (job) => (
      <span className={styles.schedule}>
        {describeCron(job.schedule.cron)}
        <code className={styles.cron}>
          {job.schedule.cron} · {job.schedule.tz}
        </code>
      </span>
    ),
  },
  {
    key: "status",
    header: "Status",
    render: (job) => (
      <span className={styles.status}>
        <StatusChip status={job.status} />
        {job.pausedReason?.type === "error" ? (
          <span className={styles.pausedReason}>
            {job.pausedReason.error.type}
          </span>
        ) : null}
      </span>
    ),
  },
  {
    key: "lastRun",
    header: "Last run",
    render: (job) => <LastRunCell jobId={job.id} />,
  },
  {
    key: "nextFire",
    header: "Next fire",
    render: (job) => <NextFireCell job={job} />,
  },
];

/** Last-run outcome (DP-1) — one newest-run read per visible row. */
function LastRunCell({ jobId }: { jobId: string }) {
  const lastRun = useJobLastRun(jobId);
  if (lastRun.isPending) return <span aria-hidden="true">…</span>;
  if (lastRun.isError) return <>—</>;
  if (!lastRun.data) return <>never</>;
  return <RunOutcome run={lastRun.data} />;
}

/** Next occurrence, computed from cron+tz; paused/archived schedules do not fire. */
function NextFireCell({ job }: { job: Job }) {
  const next = useMemo(
    () => (job.status === "active" ? nextFire(job.schedule) : null),
    [job.status, job.schedule],
  );
  return <>{next ? formatTimestamp(next.toISOString()) : "—"}</>;
}

function JobsPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<JobStatus | undefined>(undefined);
  const jobs = useJobs(status ? { status } : {});

  const rows = jobs.data?.pages.flatMap((page) => page.data) ?? [];

  return (
    <section>
      <header className={styles.header}>
        <h1 className={styles.title}>Jobs</h1>
        <span className={styles.headerActions}>
          <CreateJobAction />
          <Button
            onClick={() => void jobs.refetch()}
            disabled={jobs.isRefetching}
          >
            Refresh
          </Button>
        </span>
      </header>

      <div className={styles.filters}>
        <Select
          label="Status"
          value={status ?? ""}
          onChange={(e) =>
            setStatus((e.target.value || undefined) as JobStatus | undefined)
          }
        >
          <option value="">all</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      </div>

      {jobs.isError ? (
        <ErrorAlert label="jobs" error={jobs.error} />
      ) : jobs.isPending ? (
        <p role="status">Loading jobs…</p>
      ) : (
        <>
          <Table
            columns={COLUMNS}
            rows={rows}
            rowKey={(job) => job.id}
            caption="Jobs"
            onRowActivate={(job) =>
              void navigate({ to: "/jobs/$jobId", params: { jobId: job.id } })
            }
            empty={
              status ? (
                <EmptyState
                  title="No jobs match this filter"
                  description="Pick another status — the list shows every scheduled job in the tenant."
                />
              ) : (
                <EmptyState
                  title="No scheduled jobs yet"
                  description="A scheduled job starts sessions autonomously on a cron schedule; one-shot jobs cover single delegations."
                  cliCommand="/remote:cron create"
                />
              )
            }
          />
          {jobs.hasNextPage ? (
            <div className={styles.more}>
              <Button
                onClick={() => void jobs.fetchNextPage()}
                disabled={jobs.isFetchingNextPage}
              >
                {jobs.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
