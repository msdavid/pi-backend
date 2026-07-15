/**
 * WP-2.6 — Agent-facing `remote_*` tools for scheduled jobs (crons).
 *
 * Spec §24.6, §17. These tools let the local Pi agent manage scheduled jobs
 * that start sessions autonomously on a recurring cron schedule. One-shot jobs
 * cover the remote-delegation case. The agent can create a recurring job
 * (nightly test runs, periodic migrations), list jobs, pause a misbehaving
 * schedule, and trigger a manual run (works while paused).
 */

import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ManagedApiClient } from "../api-client.js";
import type { PiManagedSettings } from "../config.js";

/** Options injected from the extension entry point. */
export interface CronToolsOptions {
  client: () => ManagedApiClient | null;
  settings: () => PiManagedSettings;
}

// ---------------------------------------------------------------------------
// Tool parameter schemas (TypeBox)
// ---------------------------------------------------------------------------

const CreateCronParams = Type.Object({
  name: Type.String({ description: "Human-readable job name (1–128 chars, unique within the tenant)." }),
  agentId: Type.Optional(Type.String({ description: "Agent ID (defaults to piManaged.defaultAgent)." })),
  environmentId: Type.Optional(Type.String({ description: "Environment ID (defaults to piManaged.defaultEnvironment)." })),
  cron: Type.String({ description: "POSIX cron expression, max granularity minute (e.g. '0 7 * * 1-5')." }),
  tz: Type.String({ description: "IANA timezone identifier (e.g. 'America/New_York')." }),
  message: Type.String({ description: "The initial user.message event the session starts with (required, §17.1)." }),
  oneShot: Type.Optional(Type.Boolean({ description: "If true, fire once instead of recurring (delegation jobs, §14.4)." })),
});

const ListCronsParams = Type.Object({
  status: Type.Optional(Type.String({ description: "Filter by status (active | paused | archived)." })),
  limit: Type.Optional(Type.Number({ description: "Page size (default 50, max 200)." })),
});

const PauseCronParams = Type.Object({
  jobId: Type.String({ description: "The job ID to pause." }),
});

const RunCronParams = Type.Object({
  jobId: Type.String({ description: "The job ID to trigger manually." }),
});

// ---------------------------------------------------------------------------
// Tool descriptions — extremely detailed (§11.2: description quality is the
// biggest factor in tool performance; called out twice in the spec).
// ---------------------------------------------------------------------------

const CREATE_CRON_DESC = `Create a scheduled job (cron) on the Pi Managed Backend that starts an agent session autonomously on a recurring POSIX cron schedule. The job provisions a fresh session at each scheduled occurrence, seeded with the given initial user.message, and runs to completion even if no client is connected. Use this for periodic automation — nightly test suites, scheduled migrations, recurring report generation, periodic dependency audits — where the work is too long or too environment-specific to run inline. The cron expression has minute granularity and matches wall-clock time in the given IANA timezone (spring-forward skips, fall-back double-fires, with up to 10s jitter). Requires a default agent + environment (configure via piManaged or pass agentId/environmentId). Returns the new job ID and status.`;

const LIST_CRONS_DESC = `List the tenant's scheduled jobs (crons), optionally filtered by status (active, paused, archived). Use this to discover existing automation before creating a duplicate, to find a job to pause or trigger manually, or to audit what recurring sessions are running. Returns each job's ID, name, status, schedule (cron expression + timezone), and whether it is one-shot. Paginated by cursor; default page size 50.`;

const PAUSE_CRON_DESC = `Pause a scheduled job so it stops firing on its cron schedule. Running sessions already started by the job continue to completion; only future scheduled triggers are suppressed. Manual runs (remote_run_cron) still work while paused. Use this when a recurring job is misbehaving, burning budget, or producing errors and you need to stop new occurrences without losing the job definition or its run history. Pause is reversible via unpause. Returns the updated job with status 'paused'.`;

const RUN_CRON_DESC = `Trigger a manual run of a scheduled job immediately, regardless of its cron schedule or pause state (manual triggers work while paused). The job provisions a fresh session seeded with its initial user.message and records the run as manual. Use this to re-run a job on demand (e.g. after fixing a flaky test or updating a vault credential), to test a newly created job before its first scheduled occurrence, or to backfill a missed run. Returns a runId and the provisioned sessionId when available. Exactly-once firing is guaranteed server-side.`;

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createCronTools(opts: CronToolsOptions): ReturnType<typeof defineTool>[] {
  const { client, settings } = opts;

  const requireClient = (): ManagedApiClient => {
    const c = client();
    if (!c) throw new Error("Pi Managed backend is not configured. Run /remote:config first.");
    return c;
  };

  const createCron = defineTool({
    name: "remote_create_cron",
    label: "Remote create cron",
    description: CREATE_CRON_DESC,
    parameters: CreateCronParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const c = requireClient();
      const s = settings();
      const agentId = params.agentId ?? s.defaultAgent;
      const environmentId = params.environmentId ?? s.defaultEnvironment;
      if (!agentId) throw new Error("No agentId and no piManaged.defaultAgent configured.");
      if (!environmentId) throw new Error("No environmentId and no piManaged.defaultEnvironment configured.");
      const job = await c.createJob(
        {
          name: params.name,
          agent: agentId,
          environmentId,
          initialEvents: [{ type: "user.message", content: params.message }],
          schedule: { cron: params.cron, tz: params.tz },
          oneShot: params.oneShot,
        },
        `remote_create_cron_${Date.now()}`,
      );
      return {
        content: [{ type: "text", text: `Created scheduled job ${job.id} (${job.status}); ${params.cron} ${params.tz}.` }],
        details: { jobId: job.id, status: job.status },
      };
    },
  });

  const listCrons = defineTool({
    name: "remote_list_crons",
    label: "Remote list crons",
    description: LIST_CRONS_DESC,
    parameters: ListCronsParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const c = requireClient();
      const res = await c.listJobs({ status: params.status, limit: params.limit });
      return {
        content: [{ type: "text", text: `${res.data.length} job(s).` }],
        details: { jobs: res.data },
      };
    },
  });

  const pauseCron = defineTool({
    name: "remote_pause_cron",
    label: "Remote pause cron",
    description: PAUSE_CRON_DESC,
    parameters: PauseCronParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const c = requireClient();
      const job = await c.pauseJob(params.jobId, `remote_pause_cron_${Date.now()}`);
      return {
        content: [{ type: "text", text: `Paused job ${job.id} (status: ${job.status}).` }],
        details: { jobId: job.id, status: job.status },
      };
    },
  });

  const runCron = defineTool({
    name: "remote_run_cron",
    label: "Remote run cron",
    description: RUN_CRON_DESC,
    parameters: RunCronParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const c = requireClient();
      const res = await c.runJob(params.jobId, `remote_run_cron_${Date.now()}`);
      return {
        content: [{ type: "text", text: `Triggered run ${res.runId}${res.sessionId ? ` (session ${res.sessionId})` : ""}.` }],
        details: { runId: res.runId, sessionId: res.sessionId ?? null },
      };
    },
  });

  return [createCron, listCrons, pauseCron, runCron];
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Register the cron `remote_*` tools. Exported for explicit wiring (§24.6). */
export function registerCronTools(pi: ExtensionAPI, opts: CronToolsOptions): void {
  for (const tool of createCronTools(opts)) pi.registerTool(tool);
}
