/**
 * Query-key conventions (WP-C1.5).
 *
 * One key factory per resource family, mirroring `contracts/src` 1:1 (like
 * `src/features/`). Keys are hierarchical arrays so invalidation can target
 * any level: `sessionKeys.all` sweeps every session query,
 * `sessionKeys.detail(id)` sweeps one session's detail + entries + usage.
 * Later WPs add a factory per new family in this module.
 *
 * Convention: `["<family>", ...]`; list keys embed their filter object (a
 * different filter set is a different cache entry); per-resource keys nest
 * under `[..., "detail", id]`.
 */

import type { AgentListFilters } from "./agents.js";
import type { EnvironmentListFilters } from "./environments.js";
import type { FileListFilters, SkillListFilters } from "./files-skills.js";
import type { JobListFilters } from "./jobs.js";
import type { MemoryVersionFilters } from "./memory-stores.js";
import type { SessionEntriesParams, SessionListFilters } from "./sessions.js";
import type { TenantUsageFilters } from "./tenant.js";

/** Console-support endpoints (non-/v1): config + the console session. */
export const consoleKeys = {
  all: ["console"] as const,
  config: () => [...consoleKeys.all, "config"] as const,
  session: () => [...consoleKeys.all, "session"] as const,
};

/** `/v1/sessions` family. */
export const sessionKeys = {
  all: ["sessions"] as const,
  lists: () => [...sessionKeys.all, "list"] as const,
  list: (filters: SessionListFilters = {}) =>
    [...sessionKeys.lists(), filters] as const,
  details: () => [...sessionKeys.all, "detail"] as const,
  detail: (id: string) => [...sessionKeys.details(), id] as const,
  entries: (id: string, params: SessionEntriesParams = {}) =>
    [...sessionKeys.detail(id), "entries", params] as const,
  usage: (id: string) => [...sessionKeys.detail(id), "usage"] as const,
  tree: (id: string) => [...sessionKeys.detail(id), "tree"] as const,
  outputs: (id: string) => [...sessionKeys.detail(id), "outputs"] as const,
  messages: (id: string) => [...sessionKeys.detail(id), "messages"] as const,
};

/** `/v1/jobs` family (WP-C2.4). */
export const jobKeys = {
  all: ["jobs"] as const,
  lists: () => [...jobKeys.all, "list"] as const,
  list: (filters: JobListFilters = {}) => [...jobKeys.lists(), filters] as const,
  details: () => [...jobKeys.all, "detail"] as const,
  detail: (id: string) => [...jobKeys.details(), id] as const,
  runs: (id: string, params: { limit?: number } = {}) =>
    [...jobKeys.detail(id), "runs", params] as const,
};

/** `/v1/agents` family (WP-C3-prep; consumed by WP-C3.1). */
export const agentKeys = {
  all: ["agents"] as const,
  lists: () => [...agentKeys.all, "list"] as const,
  list: (filters: AgentListFilters = {}) =>
    [...agentKeys.lists(), filters] as const,
  details: () => [...agentKeys.all, "detail"] as const,
  detail: (id: string) => [...agentKeys.details(), id] as const,
  versions: (id: string, params: { limit?: number } = {}) =>
    [...agentKeys.detail(id), "versions", params] as const,
  version: (id: string, version: number) =>
    [...agentKeys.detail(id), "version", version] as const,
};

/** `/v1/environments` family (WP-C3-prep; consumed by WP-C3.2). */
export const environmentKeys = {
  all: ["environments"] as const,
  lists: () => [...environmentKeys.all, "list"] as const,
  list: (filters: EnvironmentListFilters = {}) =>
    [...environmentKeys.lists(), filters] as const,
  details: () => [...environmentKeys.all, "detail"] as const,
  detail: (id: string) => [...environmentKeys.details(), id] as const,
  workStats: (id: string) =>
    [...environmentKeys.detail(id), "work-stats"] as const,
};

/** `/v1/vaults` family (WP-C3-prep; consumed by WP-C3.3). */
export const vaultKeys = {
  all: ["vaults"] as const,
  lists: () => [...vaultKeys.all, "list"] as const,
  list: () => [...vaultKeys.lists(), {}] as const,
  details: () => [...vaultKeys.all, "detail"] as const,
  detail: (id: string) => [...vaultKeys.details(), id] as const,
  credentials: (id: string) =>
    [...vaultKeys.detail(id), "credentials"] as const,
};

/** `/v1/api-keys` family (WP-C3-prep; consumed by WP-C3.4). */
export const apiKeyKeys = {
  all: ["api-keys"] as const,
  lists: () => [...apiKeyKeys.all, "list"] as const,
  list: () => [...apiKeyKeys.lists(), {}] as const,
};

/** `/v1/webhooks` family (WP-C3-prep; consumed by WP-C3.4). */
export const webhookKeys = {
  all: ["webhooks"] as const,
  lists: () => [...webhookKeys.all, "list"] as const,
  list: () => [...webhookKeys.lists(), {}] as const,
  details: () => [...webhookKeys.all, "detail"] as const,
  detail: (id: string) => [...webhookKeys.details(), id] as const,
};

/** `/v1/files` family (WP-C3-prep; consumed by WP-C3.6). */
export const fileKeys = {
  all: ["files"] as const,
  lists: () => [...fileKeys.all, "list"] as const,
  list: (filters: FileListFilters = {}) =>
    [...fileKeys.lists(), filters] as const,
  details: () => [...fileKeys.all, "detail"] as const,
  detail: (id: string) => [...fileKeys.details(), id] as const,
};

/** `/v1/skills` family (WP-C3-prep; consumed by WP-C3.6). */
export const skillKeys = {
  all: ["skills"] as const,
  lists: () => [...skillKeys.all, "list"] as const,
  list: (filters: SkillListFilters = {}) =>
    [...skillKeys.lists(), filters] as const,
  details: () => [...skillKeys.all, "detail"] as const,
  detail: (id: string) => [...skillKeys.details(), id] as const,
  versions: (id: string) => [...skillKeys.detail(id), "versions"] as const,
};

/** `/v1/tenant` family (WP-C3-prep; consumed by WP-C3.6). */
export const tenantKeys = {
  all: ["tenant"] as const,
  info: () => [...tenantKeys.all, "info"] as const,
  usage: (filters: TenantUsageFilters = {}) =>
    [...tenantKeys.all, "usage", filters] as const,
};

/** `/v1/tenant/billing` family (WP-C5.4; saas commercialization). */
export const billingKeys = {
  all: ["billing"] as const,
  state: () => [...billingKeys.all, "state"] as const,
  ledger: (params: { limit?: number } = {}) =>
    [...billingKeys.all, "ledger", params] as const,
  autoCharge: () => [...billingKeys.all, "auto-charge"] as const,
};

/** `/v1/memory-stores` family (WP-C2.4). */
export const memoryStoreKeys = {
  all: ["memory-stores"] as const,
  lists: () => [...memoryStoreKeys.all, "list"] as const,
  list: (params: { limit?: number } = {}) =>
    [...memoryStoreKeys.lists(), params] as const,
  details: () => [...memoryStoreKeys.all, "detail"] as const,
  detail: (id: string) => [...memoryStoreKeys.details(), id] as const,
  memories: (id: string, params: { limit?: number } = {}) =>
    [...memoryStoreKeys.detail(id), "memories", params] as const,
  memory: (id: string, path: string) =>
    [...memoryStoreKeys.detail(id), "memory", path] as const,
  versions: (id: string, filters: MemoryVersionFilters = {}) =>
    [...memoryStoreKeys.detail(id), "versions", filters] as const,
  version: (id: string, versionId: string) =>
    [...memoryStoreKeys.detail(id), "version", versionId] as const,
};
