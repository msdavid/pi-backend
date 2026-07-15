/**
 * @pi-managed/contracts — Session resource family.
 *
 * Mirrors docs/api-reference.md §"Sessions". A running agent instance within an
 * environment. State machine: idle → running → rescheduling → terminated. Sandbox is
 * provisioned lazily — no work starts until a user.message event arrives.
 */

import { z } from "zod";
import { Metadata, Timestamp, Budget, Usage, StopReason } from "./common.js";
import { sessId, envId, agentId } from "./ids.js";
import { SessionAgentField, McpServer, ToolsConfig } from "./agent.js";

export const SessionStatus = z.enum(["idle", "running", "rescheduling", "terminated"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

// --- Create -----------------------------------------------------------------

export const SessionCreate = z.object({
  agent: SessionAgentField,
  environmentId: envId,
  title: z.string().optional(),
  resources: z.array(z.string()).optional(),
  vaultIds: z.array(z.string().min(1)).optional(),
  budget: Budget.optional(),
  metadata: Metadata.optional(),
});
export type SessionCreate = z.infer<typeof SessionCreate>;

// --- Patch (tools / mcpServers only, idle-only) -----------------------------

export const SessionPatch = z.object({
  agent: z.object({
    tools: ToolsConfig.optional(),
    mcpServers: z.array(McpServer).optional(),
  }),
});
export type SessionPatch = z.infer<typeof SessionPatch>;

/** Fork request body — empty (Idempotency-Key drives the new resource). */
export const SessionForkRequest = z.object({}).optional();
export type SessionForkRequest = z.infer<typeof SessionForkRequest>;

// --- Session resource -------------------------------------------------------

export const Session = z.object({
  id: sessId,
  agentId: agentId,
  agentVersion: z.number().int().positive(),
  environmentId: envId,
  title: z.string().optional(),
  status: SessionStatus,
  stopReason: StopReason.nullable(),
  budget: Budget.optional(),
  usage: Usage,
  vaultIds: z.array(z.string().min(1)),
  resources: z.array(z.string()),
  metadata: Metadata.optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  lastActivityAt: Timestamp,
  forkedFromSessionId: sessId.nullable(),
});
export type Session = z.infer<typeof Session>;

// --- Usage (cumulative) -----------------------------------------------------

export { SessionUsageResponse } from "./common.js";

// --- Entries / tree / messages ---------------------------------------------

/**
 * A positional slice entry of the session log. `seq` is the monotonic sequence
 * position (the SSE replay cursor). Payload fields are event-specific — use
 * `PersistedEvent` for the full typed shape.
 */
export const SessionEntry = z.object({
  seq: z.number().int().nonnegative(),
  type: z.string(),
  processedAt: Timestamp.nullable(),
});
export type SessionEntry = z.infer<typeof SessionEntry>;

/**
 * JSONL tree structure (branches, fork points). Opaque — concrete shape lands in
 * WP-0.4; clients must not depend on internal structure.
 */
export const SessionTree = z.unknown();

/** Post-compaction LLM-context message list (Pi `session.messages` view, §A.2 #12). */
export const SessionMessages = z.array(z.unknown());
export type SessionMessages = z.infer<typeof SessionMessages>;
