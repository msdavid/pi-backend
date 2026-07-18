/**
 * Job detail (WP-C2.4; console-spec §9.4, journey W7). The header leads with
 * the DP-1 facts — status, schedule (phrase + raw cron), next fire — and an
 * auto-paused job shows its pause reason FRONT AND CENTER (§9.4: "auto-paused
 * jobs MUST show their pause reason prominently").
 *
 * Manual trigger (write scope; §6.2 — disabled-with-explanation under
 * `read`, §6.1) works while paused (api-reference §17.7). Lifecycle ops —
 * pause/unpause/archive, admin per §9.4 — live in `./job-lifecycle.tsx`
 * (WP-C3.5), rendered right under the title row.
 */
import { createLazyRoute, getRouteApi, Link } from "@tanstack/react-router";
import { useMemo } from "react";
import type { ReactNode } from "react";
import type { Job, JobRunError, SessionAgentField } from "@pi-managed/contracts";

import { useJob, useTriggerJobRun } from "../../api/jobs.js";
import { useAuth } from "../../app/auth.js";
import { canWrite } from "../../lib/scopes.js";
import { Button } from "../../ui/button.js";
import { CopyableId } from "../../ui/copyable-id.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { JsonViewer } from "../../ui/json-viewer.js";
import { StatusChip } from "../../ui/status-chip.js";
import { useToast } from "../../ui/toast.js";
import { formatTimestamp } from "../sessions/format.js";
import { AgentId, EnvironmentId } from "../sessions/resource-ids.js";
import { JobLifecycle } from "./job-lifecycle.js";
import { RunsHistory } from "./runs-history.js";
import { describeCron, nextFire } from "./schedule.js";
import styles from "./job-detail.module.css";

export const Route = createLazyRoute("/jobs/$jobId")({
  component: JobDetailPage,
});

const routeApi = getRouteApi("/jobs/$jobId");

function JobDetailPage() {
  const { jobId } = routeApi.useParams();
  const job = useJob(jobId);

  if (job.isError) {
    return (
      <section>
        <BackLink />
        <ErrorAlert label="job" error={job.error} />
        <Button onClick={() => void job.refetch()}>Retry</Button>
      </section>
    );
  }
  if (job.isPending) {
    return (
      <section>
        <BackLink />
        <p role="status">Loading job…</p>
      </section>
    );
  }

  return <JobDetail job={job.data} />;
}

/** One line of DP-6 microcopy per §17.4/§17.6 auto-pause cause. */
const PAUSE_CAUSE: Record<JobRunError, string> = {
  agent_archived:
    "the job's agent has been archived — point the job at an active agent, then unpause",
  environment_archived:
    "the job's environment has been archived — update the environment, then unpause",
  vault_not_found:
    "a vault this job references no longer exists — update the job's vaults, then unpause",
  session_rate_limited:
    "session creation was rate-limited — the schedule retries at the next occurrence",
  service_unavailable:
    "the service was unavailable during a run — fix availability, then unpause",
};

function JobDetail({ job }: { job: Job }) {
  const { scopes } = useAuth();
  const { toast } = useToast();
  const trigger = useTriggerJobRun(job.id);
  const writable = canWrite(scopes);
  const next = useMemo(
    () => (job.status === "active" ? nextFire(job.schedule) : null),
    [job.status, job.schedule],
  );

  function runNow() {
    trigger.mutate(undefined, {
      onSuccess: ({ sessionId }) =>
        toast({
          message: sessionId
            ? `Run triggered — session ${sessionId}`
            : "Run triggered",
          tone: "success",
        }),
    });
  }

  return (
    <section>
      <BackLink />
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{job.name}</h1>
          <span className={styles.actions}>
            <Button
              variant="primary"
              onClick={runNow}
              disabled={!writable || trigger.isPending}
              aria-describedby={writable ? undefined : "run-now-scope-note"}
            >
              {trigger.isPending ? "Triggering…" : "Run now"}
            </Button>
            {!writable ? (
              <span id="run-now-scope-note" className={styles.scopeNote}>
                requires the write scope
              </span>
            ) : null}
          </span>
        </div>

        {/* §9.4 admin lifecycle: pause/unpause + archive (DP-7). */}
        <JobLifecycle job={job} />

        {/* §9.4: pause reason PROMINENTLY, before anything below the fold. */}
        {job.pausedReason ? (
          <p role="alert" className={styles.pausedBanner}>
            {job.pausedReason.type === "error" ? (
              <>
                <strong>
                  Auto-paused: {job.pausedReason.error.type.replace(/_/g, " ")}.
                </strong>{" "}
                Scheduled triggers are suppressed because{" "}
                {PAUSE_CAUSE[job.pausedReason.error.type]}. Manual runs still
                work.
              </>
            ) : (
              <>
                <strong>Paused manually.</strong> Scheduled triggers are
                suppressed; missed occurrences are not backfilled on unpause.
                Manual runs still work.
              </>
            )}
          </p>
        ) : null}

        {trigger.isError ? (
          <ErrorAlert label="manual run" error={trigger.error} />
        ) : null}

        {/* DP-1: the decisive facts lead. */}
        <div className={styles.facts}>
          <span className={styles.fact}>
            <StatusChip status={job.status} />
          </span>
          <span className={styles.fact}>
            <span className={styles.factLabel}>schedule</span>
            {describeCron(job.schedule.cron)}
            <code className={styles.cron}>
              {job.schedule.cron} · {job.schedule.tz}
            </code>
          </span>
          <span className={styles.fact}>
            <span className={styles.factLabel}>next fire</span>
            {next ? formatTimestamp(next.toISOString()) : "—"}
          </span>
        </div>

        <dl className={styles.meta}>
          <MetaRow label="ID">
            <CopyableId id={job.id} maxLength={30} />
          </MetaRow>
          <MetaRow label="Agent">
            <AgentFieldValue agent={job.agent} />
          </MetaRow>
          <MetaRow label="Environment">
            <EnvironmentId id={job.environmentId} maxLength={30} />
          </MetaRow>
          <MetaRow label="One-shot">{job.oneShot ? "yes" : "no"}</MetaRow>
          <MetaRow label="Created">{formatTimestamp(job.createdAt)}</MetaRow>
          <MetaRow label="Updated">{formatTimestamp(job.updatedAt)}</MetaRow>
        </dl>

        {/* DP-2: definition payloads collapsed until asked for. */}
        {job.sessionConfig || job.metadata ? (
          <div className={styles.payloads}>
            {job.sessionConfig ? (
              <JsonViewer label="session config" value={job.sessionConfig} />
            ) : null}
            {job.metadata ? (
              <JsonViewer label="metadata" value={job.metadata} />
            ) : null}
          </div>
        ) : null}
      </header>

      <h2 className={styles.runsTitle}>Runs</h2>
      <RunsHistory jobId={job.id} />
    </section>
  );
}

/** The three §6.3 agent wire forms: bare id, pinned version, overrides. */
function AgentFieldValue({ agent }: { agent: SessionAgentField }) {
  if (typeof agent === "string") return <AgentId id={agent} maxLength={30} />;
  return (
    <span className={styles.agent}>
      <AgentId id={agent.id} maxLength={30} />
      <span className={styles.agentQualifier}>
        {"version" in agent ? `@v${agent.version}` : "(with overrides)"}
      </span>
    </span>
  );
}

function BackLink() {
  return (
    <p className={styles.back}>
      <Link to="/jobs" className={styles.backLink}>
        ← Jobs
      </Link>
    </p>
  );
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.metaRow}>
      <dt className={styles.metaLabel}>{label}</dt>
      <dd className={styles.metaValue}>{children}</dd>
    </div>
  );
}
