/**
 * @pi-managed/contracts — prefixed resource IDs.
 *
 * Mirrors docs/api-reference.md §"ID format". IDs are prefixed, ULID-payload,
 * server-generated, opaque strings. Generated server-side; never accepted from the
 * client on creation.
 *
 * Validation is pragmatic: we check the prefix and require a non-empty suffix, treating
 * the suffix as opaque (forward-compatible with future ULID/non-ULID payloads). A
 * stricter ULID regex (`^<prefix>[0-9A-Z]{26}$`) is not enforced so legacy or
 * alternate-payload IDs still validate.
 */

import { z } from "zod";

/** Escape a literal string for embedding in a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a zod string validator that accepts any opaque ID beginning with `prefix`
 * followed by at least one character.
 */
export const prefixedId = (prefix: string): z.ZodString =>
  z
    .string()
    .min(prefix.length + 1)
    .regex(new RegExp(`^${escapeRegex(prefix)}.+`), {
      message: `must start with "${prefix}"`,
    });

/** Generic opaque resource ID (any non-empty string). */
export const ResourceId = z.string().min(1);

// --- Concrete resource IDs (§"ID format" prefix table) ---------------------

export const agentId = prefixedId("agent_");
export const envId = prefixedId("env_");
export const sessId = prefixedId("sess_");
export const vaultId = prefixedId("vault_");
export const memId = prefixedId("mem_");
export const memverId = prefixedId("memver_");
export const skillId = prefixedId("skill_");
export const fileId = prefixedId("file_");
export const jobId = prefixedId("job_");
export const whId = prefixedId("wh_");
export const whsecSecret = prefixedId("whsec_");
export const apikeyId = prefixedId("apikey_");
export const tenantId = prefixedId("tnt_");

// IDs that appear in the wire contract though not in the brief's required list:
export const vcredId = prefixedId("vcred_");
export const outcomeId = prefixedId("outc_");
export const eventId = prefixedId("evt_");
