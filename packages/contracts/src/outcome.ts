/**
 * @pi-managed/contracts — Outcome resource family.
 *
 * Mirrors docs/api-reference.md §"Outcomes". Outcome lifecycle is event-driven; the
 * REST surface is minimal (define + list). The grader is a subagent (Phase 3, §3.2).
 */

import { z } from "zod";
import { Timestamp } from "./common.js";
import { outcomeId, fileId } from "./ids.js";

// --- Rubric (§16.2, §16.3) --------------------------------------------------

export const TextRubric = z.object({
  type: z.literal("text"),
  content: z.string(),
});
export type TextRubric = z.infer<typeof TextRubric>;

export const FileRubric = z.object({
  type: z.literal("file"),
  fileId: fileId,
});
export type FileRubric = z.infer<typeof FileRubric>;

export const OutcomeRubric = z.discriminatedUnion("type", [TextRubric, FileRubric]);
export type OutcomeRubric = z.infer<typeof OutcomeRubric>;

// --- Define (§16.3) ---------------------------------------------------------

export const OutcomeCreate = z.object({
  description: z.string(),
  rubric: OutcomeRubric,
  /** Default 3, max 20. */
  maxIterations: z.number().int().min(1).max(20).optional(),
});
export type OutcomeCreate = z.infer<typeof OutcomeCreate>;

// --- Result taxonomy (§16.5) ------------------------------------------------

export const OutcomeResult = z.enum([
  "satisfied",
  "needs_revision",
  "max_iterations_reached",
  "failed",
  "interrupted",
]);
export type OutcomeResult = z.infer<typeof OutcomeResult>;

export const OutcomeStatus = z.enum([
  "active",
  "satisfied",
  "needs_revision",
  "max_iterations_reached",
  "failed",
  "interrupted",
]);
export type OutcomeStatus = z.infer<typeof OutcomeStatus>;

// --- Outcome resource -------------------------------------------------------

export const Outcome = z.object({
  id: outcomeId,
  description: z.string().optional(),
  status: OutcomeStatus,
  result: OutcomeResult.optional(),
  iteration: z.number().int().nonnegative(),
  createdAt: Timestamp,
});
export type Outcome = z.infer<typeof Outcome>;
