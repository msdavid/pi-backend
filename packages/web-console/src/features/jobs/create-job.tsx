/**
 * Create-job form (WP-C3.5; console-spec §9.4 admin ops). A dialog off the
 * jobs list: name, agent + environment pickers (from their list endpoints),
 * the required first `user.message` (§17.1), and the schedule — cron + IANA
 * timezone validated client-side via `schedule.ts` (the same parse rules the
 * backend enforces; the server remains the authority and answers `422`) with
 * a live next-fire preview from the same resolver.
 *
 * Write-gated per §6.2 (the backend guards `POST /v1/jobs` with
 * method→scope, `write`); the button is disabled-with-reason otherwise
 * (§6.1).
 */
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { JobCreate } from "@pi-managed/contracts";

import { useAgents } from "../../api/agents.js";
import { useEnvironments } from "../../api/environments.js";
import { useCreateJob } from "../../api/jobs.js";
import { useAuth } from "../../app/auth.js";
import { canWrite } from "../../lib/scopes.js";
import { Button } from "../../ui/button.js";
import { Dialog } from "../../ui/dialog.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { Input } from "../../ui/input.js";
import { Select } from "../../ui/select.js";
import { useToast } from "../../ui/toast.js";
import { formatTimestamp } from "../sessions/format.js";
import { cronError, describeCron, nextFire, timeZoneError } from "./schedule.js";
import styles from "./create-job.module.css";

/** The "New job" button + its dialog (write per §6.2, disabled-with-reason). */
export function CreateJobAction() {
  const { scopes } = useAuth();
  const writable = canWrite(scopes);
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="primary"
        onClick={() => setOpen(true)}
        disabled={!writable}
        aria-describedby={writable ? undefined : "new-job-scope-note"}
      >
        New job
      </Button>
      {!writable ? (
        <span id="new-job-scope-note" className={styles.scopeNote}>
          requires the write scope
        </span>
      ) : null}
      {open ? <CreateJobDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function CreateJobDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const create = useCreateJob();
  // Pickers: agents have no server-side status filter (list is `?name=`), so
  // archived ones are dropped here; environments filter server-side.
  const agents = useAgents();
  const environments = useEnvironments({ status: "active" });
  const activeAgents = (agents.data?.pages.flatMap((p) => p.data) ?? []).filter(
    (a) => a.status === "active",
  );
  const activeEnvironments =
    environments.data?.pages.flatMap((p) => p.data) ?? [];

  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [message, setMessage] = useState("");
  // Prefilled with a valid example (DP-6) so the preview teaches the format.
  const [cron, setCron] = useState("0 7 * * *");
  const [tz, setTz] = useState("UTC");
  const [oneShot, setOneShot] = useState(false);
  /** Required-field errors stay hidden until the first submit attempt. */
  const [submitted, setSubmitted] = useState(false);

  const cronTrim = cron.trim();
  const tzTrim = tz.trim();
  const cronErr = cronTrim ? cronError(cronTrim) : "cron is required";
  const tzErr = tzTrim ? timeZoneError(tzTrim) : "timezone is required";
  const errors = {
    name: name.trim() ? null : "name is required",
    agent: agentId ? null : "pick an agent",
    environment: environmentId ? null : "pick an environment",
    message: message.trim() ? null : "the first user message is required",
    cron: cronErr,
    tz: tzErr,
  };
  const invalid = Object.values(errors).some((e) => e !== null);

  // Live §17.2 preview from the same wall-clock resolver the list uses.
  const next = useMemo(
    () => (!cronErr && !tzErr ? nextFire({ cron: cronTrim, tz: tzTrim }) : null),
    [cronTrim, tzTrim, cronErr, tzErr],
  );

  function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (invalid) return;
    const body: JobCreate = {
      name: name.trim(),
      agent: agentId,
      environmentId,
      initialEvents: [{ type: "user.message", content: message.trim() }],
      schedule: { cron: cronTrim, tz: tzTrim },
      ...(oneShot ? { oneShot: true } : {}),
    };
    create.mutate(body, {
      onSuccess: (job) => {
        toast({ message: `Job ${job.name} created`, tone: "success" });
        onClose();
        void navigate({ to: "/jobs/$jobId", params: { jobId: job.id } });
      },
    });
  }

  return (
    <Dialog open onClose={onClose} title="New scheduled job">
      <form onSubmit={submit} noValidate className={styles.form}>
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={submitted ? errors.name : undefined}
          autoComplete="off"
        />
        <Select
          label="Agent"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          disabled={agents.isPending}
          hint={
            !agents.isPending && activeAgents.length === 0
              ? "no active agents yet — create an agent first"
              : "each run starts a session with this agent"
          }
        >
          <option value="">
            {agents.isPending ? "loading agents…" : "select an agent…"}
          </option>
          {activeAgents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
        {submitted && errors.agent ? (
          <p role="alert" className={styles.fieldError}>
            {errors.agent}
          </p>
        ) : null}
        <Select
          label="Environment"
          value={environmentId}
          onChange={(e) => setEnvironmentId(e.target.value)}
          disabled={environments.isPending}
          hint="where each run's session executes"
        >
          <option value="">
            {environments.isPending
              ? "loading environments…"
              : "select an environment…"}
          </option>
          {activeEnvironments.map((env) => (
            <option key={env.id} value={env.id}>
              {env.name}
            </option>
          ))}
        </Select>
        {submitted && errors.environment ? (
          <p role="alert" className={styles.fieldError}>
            {errors.environment}
          </p>
        ) : null}
        <Input
          label="First message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          error={submitted ? errors.message : undefined}
          hint="sent as the user.message that starts every run"
          autoComplete="off"
        />
        <div className={styles.scheduleRow}>
          <Input
            label="Cron"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            error={cronErr && (submitted || cronTrim) ? cronErr : undefined}
            hint="5 fields: minute hour day-of-month month day-of-week"
            autoComplete="off"
            spellCheck={false}
            className={styles.cronField}
          />
          <Input
            label="Timezone"
            value={tz}
            onChange={(e) => setTz(e.target.value)}
            error={tzErr && (submitted || tzTrim) ? tzErr : undefined}
            hint="IANA identifier, e.g. Europe/Rome"
            autoComplete="off"
            spellCheck={false}
            className={styles.tzField}
          />
        </div>
        {/* Live preview — same resolver as the list's next-fire column. */}
        {next ? (
          <p className={styles.preview}>
            {describeCron(cronTrim)} — next fire{" "}
            {formatTimestamp(next.toISOString())}
          </p>
        ) : null}
        <label className={styles.oneShotRow}>
          <input
            type="checkbox"
            checked={oneShot}
            onChange={(e) => setOneShot(e.target.checked)}
          />
          One-shot — fires at the next occurrence only (single delegation)
        </label>
        {create.isError ? (
          <ErrorAlert label="create job" error={create.error} />
        ) : null}
        <div className={styles.actions}>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create job"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
