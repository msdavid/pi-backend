/**
 * @pi-managed/client — `/remote:cron` and `/remote:jobs` commands (spec §24.5,
 * §17). Scheduled-job (cron) lifecycle + job-run history.
 *
 * Commands:
 * - `/remote:cron list` — list scheduled jobs.
 * - `/remote:cron create` — interactively create a scheduled job.
 * - `/remote:cron pause <jobId>` — pause (running sessions continue).
 * - `/remote:cron unpause <jobId>` — resume from next occurrence.
 * - `/remote:cron run <jobId>` — manual trigger (works while paused).
 * - `/remote:cron archive <jobId>` — terminal archive.
 * - `/remote:jobs <jobId>` — list deployment runs for a job.
 *
 * The run* functions are decoupled from Pi types (deps-injected) so they can be
 * unit-tested against a mock client.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Job } from "@pi-managed/contracts";
import { ApiClientError, type ManagedApiClient } from "../api-client.js";
import { buildClientFromContext, settingsFor } from "./remote.js";

/** UI slice these commands need (structural subset of ctx.ui). */
export interface CronUi {
  notify(msg: string, type?: "info" | "warning" | "error"): void;
  setWidget(key: string, lines: string[] | undefined): void;
  setStatus(key: string, text: string | undefined): void;
  input(title: string, placeholder?: string): Promise<string | undefined>;
}

/** Dependencies for the run* functions (all injectable for testing). */
export interface CronCommandDeps {
  ui: CronUi;
  /** Build an authenticated client, or undefined if the backend isn't configured. */
  createClient(): ManagedApiClient | undefined;
  /** Defaults for agent/environment (cron create requires both). */
  defaultAgent?: string;
  defaultEnvironment?: string;
}

// --- helpers ----------------------------------------------------------------

function parseArgs(args: string): string[] {
  return args.trim().split(/\s+/).filter((t) => t !== "");
}

function notConfigured(ui: CronUi): void {
  ui.notify("Pi Managed Backend is not configured. Run /remote:config first.", "error");
}

function catchClientError(ui: CronUi, e: unknown, what: string): boolean {
  if (e instanceof ApiClientError) {
    ui.notify(`${what} failed: ${e.message}`, "error");
    return true;
  }
  return false;
}

// --- /remote:cron list ------------------------------------------------------

export async function runCronList(deps: CronCommandDeps): Promise<void> {
  const client = deps.createClient();
  if (!client) return notConfigured(deps.ui);
  let page;
  try {
    page = await client.listJobs({ limit: 50 });
  } catch (e) {
    if (catchClientError(deps.ui, e, "Listing jobs")) return;
    throw e;
  }
  if (page.data.length === 0) {
    deps.ui.notify("No scheduled jobs.", "info");
    return;
  }
  const lines = ["Scheduled jobs:"];
  for (const j of page.data) {
    lines.push(`  ${j.id} · ${j.status} · ${j.name} · ${j.schedule.cron} (${j.schedule.tz})`);
  }
  deps.ui.setWidget("pi-managed:crons", lines.slice(0, 50));
  deps.ui.setStatus("pi-managed", `${page.data.length} job(s)`);
}

// --- /remote:cron create ---------------------------------------------------

export async function runCronCreate(deps: CronCommandDeps): Promise<void> {
  const client = deps.createClient();
  if (!client) return notConfigured(deps.ui);
  if (!deps.defaultAgent || !deps.defaultEnvironment) {
    deps.ui.notify(
      "Cron create requires a default agent + environment (set via /remote:config).",
      "error",
    );
    return;
  }
  const name = await deps.ui.input("Job name", "nightly-test-run");
  if (!name) return;
  const cron = await deps.ui.input("Cron expression (POSIX, minute granularity)", "0 7 * * 1-5");
  if (!cron) return;
  const tz = await deps.ui.input("Timezone (IANA identifier)", "America/New_York");
  if (!tz) return;
  const message = await deps.ui.input("Initial user.message", "Pull latest and run the suite");
  if (!message) return;
  let job: Job;
  try {
    job = await client.createJob({
      name,
      agent: deps.defaultAgent,
      environmentId: deps.defaultEnvironment,
      initialEvents: [{ type: "user.message", content: message }],
      schedule: { cron, tz },
    });
  } catch (e) {
    if (catchClientError(deps.ui, e, "Creating job")) return;
    throw e;
  }
  deps.ui.notify(`Created job ${job.id} (${job.status}).`, "info");
}

// --- /remote:cron pause / unpause / run / archive --------------------------

async function jobAction(
  deps: CronCommandDeps,
  args: string,
  fn: (client: ManagedApiClient, id: string) => Promise<unknown>,
  what: string,
  fmt: (result: unknown, client: ManagedApiClient) => string,
): Promise<void> {
  const [jobId] = parseArgs(args);
  const client = deps.createClient();
  if (!client) return notConfigured(deps.ui);
  if (!jobId) {
    deps.ui.notify(`Usage: /remote:cron ${what.toLowerCase()} <jobId>`, "error");
    return;
  }
  let result: unknown;
  try {
    result = await fn(client, jobId);
  } catch (e) {
    if (catchClientError(deps.ui, e, what)) return;
    throw e;
  }
  deps.ui.notify(fmt(result, client), "info");
}

export function runCronPause(deps: CronCommandDeps, args: string): Promise<void> {
  return jobAction(deps, args, (c, id) => c.pauseJob(id), "Pause", (r) => {
    const j = r as Job;
    return `Paused job ${j.id} (${j.status}).`;
  });
}

export function runCronUnpause(deps: CronCommandDeps, args: string): Promise<void> {
  return jobAction(deps, args, (c, id) => c.unpauseJob(id), "Unpause", (r) => {
    const j = r as Job;
    return `Resumed job ${j.id} (${j.status}).`;
  });
}

export function runCronArchive(deps: CronCommandDeps, args: string): Promise<void> {
  return jobAction(deps, args, (c, id) => c.archiveJob(id), "Archive", (r) => {
    const j = r as Job;
    return `Archived job ${j.id} (${j.status}).`;
  });
}

export function runCronRun(deps: CronCommandDeps, args: string): Promise<void> {
  return jobAction(deps, args, (c, id) => c.runJob(id), "Run", (r, client) => {
    const res = r as { runId: string; sessionId?: string };
    if (!res.sessionId) return `Triggered run ${res.runId}.`;
    // Session ids print with their console deep link (console-spec §1.4).
    return `Triggered run ${res.runId} (session ${res.sessionId}). Console: ${client.consoleSessionUrl(res.sessionId)}`;
  });
}

// --- /remote:jobs <jobId> ---------------------------------------------------

export async function runJobs(deps: CronCommandDeps, args: string): Promise<void> {
  const [jobId] = parseArgs(args);
  const client = deps.createClient();
  if (!client) return notConfigured(deps.ui);
  if (!jobId) {
    deps.ui.notify("Usage: /remote:jobs <jobId>", "error");
    return;
  }
  let page;
  try {
    page = await client.listJobRuns(jobId, { limit: 50 });
  } catch (e) {
    if (catchClientError(deps.ui, e, "Listing job runs")) return;
    throw e;
  }
  if (page.data.length === 0) {
    deps.ui.notify(`No runs recorded for job ${jobId}.`, "info");
    return;
  }
  const lines = [`Runs for job ${jobId}:`];
  for (const r of page.data) {
    const err = r.error ? ` · error=${r.error.type}` : "";
    const manual = r.manual ? " · manual" : "";
    lines.push(`  ${r.id} · sched ${r.scheduledAt}${manual}${err}`);
  }
  deps.ui.setWidget("pi-managed:job-runs", lines.slice(0, 50));
  deps.ui.setStatus("pi-managed", `${page.data.length} run(s)`);
}

// --- Pi wiring -------------------------------------------------------------

/**
 * Register the `/remote:cron` and `/remote:jobs` commands with Pi.
 * RPC-invokable.
 */
export function registerCronCommands(pi: ExtensionAPI): void {
  const deps = (ctx: ExtensionCommandContext): CronCommandDeps => ({
    ui: ctx.ui,
    createClient: () => buildClientFromContext(ctx),
    defaultAgent: settingsFor(ctx).defaultAgent,
    defaultEnvironment: settingsFor(ctx).defaultEnvironment,
  });

  pi.registerCommand("remote:cron", {
    description: "Manage scheduled jobs: /remote:cron <list|create|pause|unpause|run|archive> (spec §24.5, §17).",
    handler: async (args, ctx) => {
      const [sub, ...rest] = parseArgs(args);
      const restArgs = rest.join(" ");
      const d = deps(ctx);
      switch (sub) {
        case "list":
          return runCronList(d);
        case "create":
          return runCronCreate(d);
        case "pause":
          return runCronPause(d, restArgs);
        case "unpause":
          return runCronUnpause(d, restArgs);
        case "run":
          return runCronRun(d, restArgs);
        case "archive":
          return runCronArchive(d, restArgs);
        default:
          d.ui.notify(
            "Usage: /remote:cron <list|create|pause|unpause|run|archive>",
            "error",
          );
      }
    },
  });

  pi.registerCommand("remote:jobs", {
    description: "List deployment runs for a scheduled job: /remote:jobs <jobId> (spec §17.4).",
    handler: async (args, ctx) => runJobs(deps(ctx), args),
  });
}
