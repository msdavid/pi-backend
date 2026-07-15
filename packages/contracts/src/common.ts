/**
 * @pi-managed/contracts — shared wire types.
 *
 * Mirrors docs/api-reference.md Conventions §: error envelope, error-code taxonomy,
 * cursor pagination, name rules, timestamps, metadata rules, and the cross-cutting
 * budget/usage shapes referenced by Agents/Sessions.
 */

import { z } from "zod";

// --- Timestamps (§"Timestamps") --------------------------------------------

/** RFC 3339 UTC timestamp with trailing `Z`, e.g. `2026-07-13T12:00:00.123Z`. */
export const Timestamp = z.string().datetime();
export type Timestamp = z.infer<typeof Timestamp>;

// --- Name (§"Name rules") ---------------------------------------------------

/**
 * Human-readable `name`. 1–128 chars; Unicode letters/numbers, spaces, hyphens,
 * underscores. Disallows control chars and `/`. Uniqueness within
 * (tenant, resource-type) is enforced server-side.
 */
export const Name = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\p{L}\p{N} _-]+$/u, {
    message:
      "must contain only Unicode letters, numbers, spaces, hyphens, underscores",
  });
export type Name = z.infer<typeof Name>;

// --- metadata (§"metadata rules") ------------------------------------------

/** Scalar metadata value: string, number, boolean, or null. No nested objects/arrays. */
export const MetadataValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type MetadataValue = z.infer<typeof MetadataValue>;

/**
 * Arbitrary `metadata` object. Keys match `[a-zA-Z0-9_.-]+`; values are scalars only.
 * Max encoded size 4 KiB (enforced server-side → 422 invalid_request on overflow).
 */
export const Metadata = z.record(z.string().regex(/^[a-zA-Z0-9_.-]+$/), MetadataValue);
export type Metadata = z.infer<typeof Metadata>;

// --- Resource status --------------------------------------------------------

export const ResourceStatus = z.enum(["active", "archived"]);
export type ResourceStatus = z.infer<typeof ResourceStatus>;

// --- Cursor pagination (§"Cursor pagination") -------------------------------

/** Query params accepted by every list endpoint. */
export const ListParams = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});
export type ListParams = z.infer<typeof ListParams>;

/** Response wrapper for every list endpoint. */
export const Cursor = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    data: z.array(item),
    nextCursor: z.string().nullable(),
  });
export type Cursor<T> = { data: T[]; nextCursor: string | null };

// --- Error envelope (§"Error envelope") ------------------------------------

/** The 13 machine-stable error codes (§"Error code taxonomy"). FINAL. */
export const ErrorCode = z.enum([
  "invalid_request",
  "not_found",
  "unauthorized",
  "forbidden",
  "conflict",
  "rate_limited",
  "payload_too_large",
  "internal_error",
  "resource_archived",
  "budget_exhausted",
  "requires_action",
  "session_not_idle",
  "idempotency_conflict",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/**
 * Coarse error `type` for client branching. Left permissive (string) — the doc lists
 * examples (`request_error`, `authentication_error`, `server_error`) and the
 * machine-stable discriminator is `code`, not `type`.
 */
export const ErrorType = z.string();
export type ErrorType = z.infer<typeof ErrorType>;

/** Structured, code-specific context (field paths, conflicting IDs, blocking event IDs). */
export const ErrorDetails = z.record(z.string(), z.unknown());

export const ErrorEnvelope = z.object({
  error: z.object({
    type: ErrorType,
    code: ErrorCode,
    message: z.string(),
    details: ErrorDetails.optional(),
    requestId: z.string(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

// --- Budget & Usage (§Sessions) --------------------------------------------

/** Hard spend caps for a session. Exceeded → idle + stopReason budget_exhausted. */
export const Budget = z.object({
  maxTokens: z.number().int().nonnegative().optional(),
  maxUsd: z.number().nonnegative().optional(),
});
export type Budget = z.infer<typeof Budget>;

export const Usage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheCreationInputTokens: z.number().int().nonnegative(),
  cacheReadInputTokens: z.number().int().nonnegative(),
});
export type Usage = z.infer<typeof Usage>;

/** Cumulative token usage response (GET /v1/sessions/:id/usage). */
export const SessionUsageResponse = Usage.extend({
  usdCost: z.number().nonnegative(),
});
export type SessionUsageResponse = z.infer<typeof SessionUsageResponse>;

// --- Stop reason (§Events & SSE) -------------------------------------------

export const StopReason = z.enum([
  "requires_action",
  "budget_exhausted",
  "user_interrupt",
  "error",
  "completed",
]);
export type StopReason = z.infer<typeof StopReason>;
