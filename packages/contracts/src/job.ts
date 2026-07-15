/**
 * @pi-managed/contracts — Scheduled jobs & job runs.
 *
 * Mirrors docs/api-reference.md §"Scheduled Jobs (Crons)". A scheduled job starts
 * sessions autonomously on a recurring cron schedule. One-shot jobs cover the
 * remote-delegation case.
 */

import { z } from "zod";
import { Name, Metadata, Timestamp } from "./common.js";
import { jobId } from "./ids.js";
import { SessionAgentField } from "./agent.js";
import { InboundEvent } from "./events.js";
import { Budget } from "./common.js";

export const JobStatus = z.enum(["active", "paused", "archived"]);
export type JobStatus = z.infer<typeof JobStatus>;

export const JobSchedule = z.object({
  /** POSIX cron, max granularity minute (§17.2). */
  cron: z.string(),
  /** IANA identifier (§17.2). */
  tz: z.string(),
});
export type JobSchedule = z.infer<typeof JobSchedule>;

export const JobSessionConfig = z.object({
  resources: z.array(z.string()).optional(),
  vaultIds: z.array(z.string().min(1)).optional(),
  budget: Budget.optional(),
});
export type JobSessionConfig = z.infer<typeof JobSessionConfig>;

// --- Create -----------------------------------------------------------------

export const JobCreate = z.object({
  name: Name,
  agent: SessionAgentField,
  environmentId: z.string(),
  /** Required — a user.message event (§17.1). */
  initialEvents: z.array(InboundEvent),
  sessionConfig: JobSessionConfig.optional(),
  schedule: JobSchedule,
  oneShot: z.boolean().optional(),
  metadata: Metadata.optional(),
});
export type JobCreate = z.infer<typeof JobCreate>;

// --- Paused reason (§17.4/§17.6) -------------------------------------------

export const JobRunError = z.enum([
  "environment_archived",
  "agent_archived",
  "vault_not_found",
  "session_rate_limited",
  "service_unavailable",
]);
export type JobRunError = z.infer<typeof JobRunError>;

export const PausedReason = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual") }),
  z.object({
    type: z.literal("error"),
    error: z.object({ type: JobRunError }),
  }),
]);
export type PausedReason = z.infer<typeof PausedReason>;

// --- Job resource -----------------------------------------------------------

export const Job = z.object({
  id: jobId,
  name: Name,
  status: JobStatus,
  agent: SessionAgentField,
  environmentId: z.string(),
  schedule: JobSchedule,
  oneShot: z.boolean(),
  pausedReason: PausedReason.optional(),
  sessionConfig: JobSessionConfig.optional(),
  metadata: Metadata.optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Job = z.infer<typeof Job>;

// --- Job run ----------------------------------------------------------------

export const JobRun = z.object({
  id: z.string(),
  scheduledAt: Timestamp,
  triggeredAt: Timestamp.optional(),
  sessionId: z.string().optional(),
  manual: z.boolean().optional(),
  error: z.object({ type: JobRunError }).optional(),
  createdAt: Timestamp,
});
export type JobRun = z.infer<typeof JobRun>;

/** POST /v1/jobs/:id/run response (202). */
export const JobRunTriggerResponse = z.object({
  runId: z.string(),
  sessionId: z.string().optional(),
});
export type JobRunTriggerResponse = z.infer<typeof JobRunTriggerResponse>;

// --- Action request bodies (empty — Idempotency-Key in header) --------------

export const JobActionRequest = z.object({}).optional();
export type JobActionRequest = z.infer<typeof JobActionRequest>;
