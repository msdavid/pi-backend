/**
 * Job lifecycle controls (WP-C3.5; console-spec §9.4, §17.5):
 * pause / unpause, and archive behind a DP-7 typed confirmation naming the
 * real consequences — terminal: the schedule stops AND the job disappears
 * from every read (the backend hides archived jobs from list/detail/runs,
 * pinned by `jobs-lifecycle.contract.test.ts`), so success navigates back
 * to the jobs list. Write-gated (§6.2 — the backend guards job mutations
 * with method→scope, `write`) with a visible reason (§6.1); failures
 * surface the DP-9 facts inline.
 */
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { Job } from "@pi-managed/contracts";

import { usePauseJob, useUnpauseJob, useArchiveJob } from "../../api/jobs.js";
import { useAuth } from "../../app/auth.js";
import { canWrite } from "../../lib/scopes.js";
import { Button } from "../../ui/button.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { TypedConfirmDialog } from "../../ui/typed-confirm-dialog.js";
import { useToast } from "../../ui/toast.js";
import styles from "./job-lifecycle.module.css";

export function JobLifecycle({ job }: { job: Job }) {
  const navigate = useNavigate();
  const { scopes } = useAuth();
  const writable = canWrite(scopes);
  const { toast } = useToast();
  const pause = usePauseJob(job.id);
  const unpause = useUnpauseJob(job.id);
  const archive = useArchiveJob(job.id);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Unreachable through the API (archived jobs 404 on read) — guard against
  // a transiently cached archived job anyway.
  if (job.status === "archived") return null;

  function onPause() {
    pause.mutate(undefined, {
      onSuccess: () =>
        toast({
          message: "Job paused — scheduled triggers suppressed",
          tone: "success",
        }),
    });
  }

  function onUnpause() {
    unpause.mutate(undefined, {
      onSuccess: () =>
        toast({
          message:
            "Job unpaused — resumes at the next occurrence (missed runs are not backfilled)",
          tone: "success",
        }),
    });
  }

  function onArchive() {
    archive.mutate(undefined, {
      onSuccess: () => {
        setConfirmOpen(false);
        toast({
          message: `Job ${job.name} archived — schedule stopped; it no longer appears in the console`,
          tone: "success",
        });
        // The detail read would now 404 — back to the list.
        void navigate({ to: "/jobs" });
      },
    });
  }

  return (
    <div className={styles.lifecycle}>
      <div className={styles.buttons}>
        {job.status === "paused" ? (
          <Button
            onClick={onUnpause}
            disabled={!writable || unpause.isPending}
            aria-describedby={writable ? undefined : "job-lifecycle-scope-note"}
          >
            {unpause.isPending ? "Unpausing…" : "Unpause"}
          </Button>
        ) : (
          <Button
            onClick={onPause}
            disabled={!writable || pause.isPending}
            aria-describedby={writable ? undefined : "job-lifecycle-scope-note"}
          >
            {pause.isPending ? "Pausing…" : "Pause"}
          </Button>
        )}
        <Button
          variant="destructive"
          onClick={() => setConfirmOpen(true)}
          disabled={!writable}
          aria-describedby={writable ? undefined : "job-lifecycle-scope-note"}
        >
          Archive
        </Button>
        {!writable ? (
          <span id="job-lifecycle-scope-note" className={styles.scopeNote}>
            requires the write scope
          </span>
        ) : null}
      </div>

      {pause.isError ? <ErrorAlert label="pause" error={pause.error} /> : null}
      {unpause.isError ? (
        <ErrorAlert label="unpause" error={unpause.error} />
      ) : null}
      {archive.isError ? (
        <ErrorAlert label="archive" error={archive.error} />
      ) : null}

      {/* DP-7: consequence language sourced from real API behavior
          (terminal + hidden from reads, §17.5 / job-service.ts). */}
      <TypedConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={onArchive}
        title="Archive job"
        resourceName={job.name}
        consequence={`Archiving "${job.name}" is terminal: its schedule stops permanently and the job — including this runs history — disappears from the console and API reads. It cannot be unarchived or run again; sessions it already started are unaffected.`}
        confirmLabel={archive.isPending ? "Archiving…" : "Archive job"}
      />
    </div>
  );
}
