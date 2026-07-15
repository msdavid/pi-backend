/**
 * Roster resolution + validation (WP-3.1, spec §18.3).
 *
 * A roster is 1–20 entries. Each entry references an agent by id (latest, pinned at
 * coordinator-creation) or by pinned version, or is `{"type":"self"}`. Resolution
 * takes a **snapshot at creation time**: the referenced agent's current version (or
 * the pinned version) + its {@link AgentConfig} are captured and frozen. Later agent
 * updates do not affect threads spawned from this roster (§18.3).
 *
 * Constraints enforced here:
 * - 1–20 entries ({@link MAX_ROSTER_ENTRIES}).
 * - ≤20 unique referenced agent ids ({@link MAX_UNIQUE_AGENTS}); multiple copies of
 *   the same agent are allowed.
 * - `self` resolves to the primary agent's id/version/config.
 *
 * Depth-1-only delegation (§18.2) is structural: child threads do not load the
 * subagent extension (the coordinator passes an empty `extensionFactories` to the
 * child material), so a child cannot itself delegate. Rosters on child agents are
 * therefore inert — "depth > 1 ignored".
 */

import type { AgentConfig } from "@pi-managed/contracts";
import { ApiError } from "../errors.js";
import {
  MAX_ROSTER_ENTRIES,
  MAX_UNIQUE_AGENTS,
  type ResolvedRosterEntry,
  type RosterEntry,
  type RosterEntrySpec,
} from "./types.js";

/**
 * Lookup result for a referenced agent. The resolver fetches the pinned version's
 * config. For `self`, the coordinator supplies the primary agent's material.
 */
export interface AgentLookup {
  agentId: string;
  version: number;
  config: AgentConfig;
}

/**
 * Resolve agent by id + optional pinned version. Returns the pinned
 * `{agentId, version, config}`. `version` omitted ⇒ the agent's current (latest)
 * version at this moment (snapshot-at-creation).
 */
export type AgentResolver = (
  agentId: string,
  version?: number,
) => Promise<AgentLookup>;

/** Options for {@link resolveRoster}. */
export interface ResolveRosterOptions {
  /** The declared roster entries (1–20). */
  entries: RosterEntry[];
  /** Resolver for `by_id` entries (fetches the pinned version + config). */
  resolveAgent: AgentResolver;
  /** The primary agent's id/version/config (resolves `self` entries). */
  primary: { agentId: string; version: number; config: AgentConfig };
}

/**
 * Validate + resolve a roster to a snapshot-at-creation list. Throws `ApiError 422`
 * on violation. The returned entries are frozen (snapshot); callers MUST NOT mutate
 * the captured `agentConfig`.
 */
export async function resolveRoster(
  opts: ResolveRosterOptions,
): Promise<ResolvedRosterEntry[]> {
  const { entries, resolveAgent, primary } = opts;

  if (entries.length < 1 || entries.length > MAX_ROSTER_ENTRIES) {
    throw new ApiError(
      422,
      "invalid_request",
      `multiagent roster must have 1..${MAX_ROSTER_ENTRIES} entries (got ${entries.length})`,
    );
  }

  const resolved: ResolvedRosterEntry[] = [];
  const uniqueAgentIds = new Set<string>();

  for (const entry of entries) {
    const spec = entry.spec;
    let lookup: AgentLookup;
    let isSelf = false;

    if (spec.type === "self") {
      lookup = {
        agentId: primary.agentId,
        version: primary.version,
        config: primary.config,
      };
      isSelf = true;
    } else {
      validateSpec(spec);
      lookup = await resolveAgent(spec.agentId, spec.version);
    }

    uniqueAgentIds.add(lookup.agentId);
    if (uniqueAgentIds.size > MAX_UNIQUE_AGENTS) {
      throw new ApiError(
        422,
        "invalid_request",
        `multiagent roster references more than ${MAX_UNIQUE_AGENTS} unique agents`,
      );
    }

    resolved.push({
      name: entry.name,
      spec,
      resolvedAgentId: lookup.agentId,
      resolvedVersion: lookup.version,
      agentConfig: lookup.config,
      isSelf,
    });
  }

  return resolved;
}

/** Validate a `by_id` spec's shape (agentId non-empty; version positive). */
export function validateSpec(spec: RosterEntrySpec): void {
  if (spec.type === "self") return;
  if (!spec.agentId || spec.agentId.trim() === "") {
    throw new ApiError(422, "invalid_request", "roster entry agentId is required");
  }
  if (spec.version !== undefined && (!Number.isInteger(spec.version) || spec.version < 1)) {
    throw new ApiError(
      422,
      "invalid_request",
      `roster entry version must be a positive integer (got ${spec.version})`,
    );
  }
}

/**
 * Is `roster` capable of further delegation? Always `false` for child threads — the
 * subagent extension is only loaded into the *primary* thread (§18.2 depth-1-only).
 * This helper documents the invariant; the enforcement is in the coordinator
 * (child materials carry no subagent `extensionFactories`).
 */
export function canDelegate(isPrimary: boolean): boolean {
  return isPrimary;
}
