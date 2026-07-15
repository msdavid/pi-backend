/**
 * @pi-managed/contracts — Agent resource family.
 *
 * Mirrors docs/api-reference.md §"Agents". A reusable, versioned definition of how a
 * Pi agent behaves. Config fields: model, systemPrompt, tools, skills, extensions,
 * mcpServers, multiagent roster. Versioned (PATCH creates a new immutable version).
 */

import { z } from "zod";
import { Name, Metadata, ResourceStatus, Timestamp } from "./common.js";
import { agentId, skillId } from "./ids.js";

// --- Model ref --------------------------------------------------------------

export const ModelRef = z.object({
  provider: z.string(),
  id: z.string(),
  /** Provider-dependent thinking-level hint (e.g. "low"|"medium"|"high"). */
  thinkingLevel: z.string().optional(),
});
export type ModelRef = z.infer<typeof ModelRef>;

// --- Tools config (§11.1, §22.2) -------------------------------------------

export const PermissionPolicy = z.enum(["always_allow", "always_ask", "always_deny"]);
export type PermissionPolicy = z.infer<typeof PermissionPolicy>;

export const ToolConfig = z.object({
  enabled: z.boolean().optional(),
  permissionPolicy: PermissionPolicy.optional(),
});
export type ToolConfig = z.infer<typeof ToolConfig>;

export const ToolsConfig = z.object({
  defaultConfig: ToolConfig,
  configs: z.record(z.string(), ToolConfig),
});
export type ToolsConfig = z.infer<typeof ToolsConfig>;

// --- Skills refs (§20) ------------------------------------------------------

export const SkillRef = z.object({
  type: z.enum(["prebuilt", "custom"]),
  skillId: skillId,
  version: z.number().int().positive().optional(),
});
export type SkillRef = z.infer<typeof SkillRef>;

// --- MCP servers (§19.3) ----------------------------------------------------

export const McpServer = z.object({
  name: z.string(),
  /**
   * The MCP server address. Tenant-supplied, so it MUST be a syntactically valid
   * absolute URL restricted to the `http`/`https` schemes — no `file:`, `gopher:`,
   * or other schemes that would let a definition steer host-side egress at another
   * protocol (§19.3, SEC-2). Host/IP reachability (SSRF) is enforced separately at
   * connect time by the pinned transport (`domain/net/ssrf-pin.ts`).
   */
  url: z
    .string()
    .url()
    .refine(
      (u) => {
        try {
          const scheme = new URL(u).protocol;
          return scheme === "http:" || scheme === "https:";
        } catch {
          return false;
        }
      },
      { message: "MCP server url must use the http or https scheme" },
    ),
  type: z.literal("url"),
});
export type McpServer = z.infer<typeof McpServer>;

// --- Multiagent roster (§18.3 — shape stubbed pending WP-0.4 detail) -------

export const MultiagentRosterEntry = z
  .object({
    name: z.string().optional(),
    agentId: agentId.optional(),
    role: z.string().optional(),
  })
  .catchall(z.unknown());
export type MultiagentRosterEntry = z.infer<typeof MultiagentRosterEntry>;

export const MultiagentConfig = z.object({
  roster: z.array(MultiagentRosterEntry),
});
export type MultiagentConfig = z.infer<typeof MultiagentConfig>;

// --- Agent config (the versioned blob) -------------------------------------

export const AgentConfig = z.object({
  model: ModelRef,
  systemPrompt: z.string().optional(),
  tools: ToolsConfig.optional(),
  skills: z.array(SkillRef).max(20).optional(),
  extensions: z.array(z.string()).optional(),
  mcpServers: z.array(McpServer).max(20).optional(),
  multiagent: MultiagentConfig.optional(),
});
export type AgentConfig = z.infer<typeof AgentConfig>;

// --- Create / Update --------------------------------------------------------

export const AgentCreate = AgentConfig.extend({
  name: Name,
  metadata: Metadata.optional(),
});
export type AgentCreate = z.infer<typeof AgentCreate>;

/** PATCH — any subset of create fields; creates a new immutable version. */
export const AgentUpdate = AgentCreate.partial();
export type AgentUpdate = z.infer<typeof AgentUpdate>;

// --- Agent resource (response) ---------------------------------------------

export const Agent = z.object({
  id: agentId,
  name: Name,
  currentVersion: z.number().int().positive(),
  status: ResourceStatus,
  /** Expanded current-version config (present on retrieve). */
  config: AgentConfig.optional(),
  metadata: Metadata.optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Agent = z.infer<typeof Agent>;

// --- Versions ---------------------------------------------------------------

export const AgentVersion = z.object({
  version: z.number().int().positive(),
  config: AgentConfig,
  createdAt: Timestamp,
});
export type AgentVersion = z.infer<typeof AgentVersion>;

// --- Session agent field — 3 forms (§6.3) ----------------------------------

/**
 * The `agent` field on session/job creation. Three wire forms:
 *  1. bare ID (latest version),
 *  2. pinned version `{id, version}`,
 *  3. overrides `{id, overrides}` (omit→inherit; null→clear; value→full replace, no merge).
 *
 * Not a clean discriminated union (form 1 is a bare string); modeled as a union.
 */
export const PinnedAgent = z.object({
  id: agentId,
  version: z.number().int().positive(),
});
export type PinnedAgent = z.infer<typeof PinnedAgent>;

/** Per-session overrides — full-replace semantics on each present field. */
export const AgentOverrides = AgentConfig.partial();
export type AgentOverrides = z.infer<typeof AgentOverrides>;

export const OverrideAgent = z.object({
  id: agentId,
  overrides: AgentOverrides,
});
export type OverrideAgent = z.infer<typeof OverrideAgent>;

export const SessionAgentField = z.union([agentId, PinnedAgent, OverrideAgent]);
export type SessionAgentField = z.infer<typeof SessionAgentField>;
