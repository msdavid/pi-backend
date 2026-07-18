/**
 * Count of scheduled jobs referencing an agent — the DP-7 consequence fact
 * for the archive dialog ("auto-archives N scheduled jobs", console-spec
 * §9.1 / journey W10). The jobs API has no `?agentId=` filter (backend
 * `api/jobs.ts` lists by `?status=` only), so the count is computed
 * client-side by walking the jobs list and matching the §6.3 agent field
 * forms (bare id / pinned / overrides). A tenant with more than
 * `PAGE_LIMIT × MAX_PAGES` jobs degrades to an honest lower bound, and a
 * failed read degrades to consequence copy with no number
 * ({@link describeArchiveConsequence}).
 */
import { useQuery } from "@tanstack/react-query";
import type { Job } from "@pi-managed/contracts";

import type { ConsoleApi } from "../../api/client.js";
import { agentKeys } from "../../api/keys.js";
import { listJobs } from "../../api/jobs.js";
import { useApiClient } from "../../api/provider.js";

const PAGE_LIMIT = 100;
const MAX_PAGES = 5;

/** All three §6.3 agent wire forms carry the id. */
function referencesAgent(job: Job, agentId: string): boolean {
  return typeof job.agent === "string"
    ? job.agent === agentId
    : job.agent.id === agentId;
}

export interface ReferencingJobs {
  /** Non-archived jobs referencing the agent (the ones archival touches). */
  count: number;
  /** False when the walk hit the page cap — `count` is a lower bound. */
  exact: boolean;
}

export async function countReferencingJobs(
  agentId: string,
  client: ConsoleApi,
): Promise<ReferencingJobs> {
  let count = 0;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await listJobs(
      { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
      client,
    );
    count += result.data.filter(
      (job) => job.status !== "archived" && referencesAgent(job, agentId),
    ).length;
    if (!result.nextCursor) return { count, exact: true };
    cursor = result.nextCursor;
  }
  return { count, exact: false };
}

/** Fetched only while the archive dialog is open (`enabled`). */
export function useReferencingJobs(agentId: string, enabled: boolean) {
  const client = useApiClient();
  return useQuery({
    queryKey: [...agentKeys.detail(agentId), "referencing-jobs"],
    queryFn: () => countReferencingJobs(agentId, client),
    enabled,
  });
}

/**
 * The DP-7 consequence sentence for the archive dialog, sourced from real
 * API behavior (api-reference §"POST /v1/agents/:id/archive": terminal;
 * referencing jobs auto-archived in the same operation).
 */
export function describeArchiveConsequence(query: {
  data?: ReferencingJobs;
  isError: boolean;
}): string {
  const terminal =
    "Archival is terminal: the agent becomes read-only, cannot be unarchived, and new sessions can no longer reference it.";
  if (query.isError) {
    return `${terminal} Any scheduled jobs referencing this agent are auto-archived in the same operation (the console could not read the jobs list to count them).`;
  }
  if (!query.data) {
    return `${terminal} Counting the scheduled jobs this will auto-archive…`;
  }
  const { count, exact } = query.data;
  if (count === 0 && exact) {
    return `${terminal} No scheduled jobs reference this agent.`;
  }
  const jobs = `${count} scheduled job${count === 1 ? "" : "s"}`;
  return `${terminal} This auto-archives ${exact ? "the " : "at least "}${jobs} referencing this agent.`;
}
