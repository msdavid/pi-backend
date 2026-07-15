/**
 * @pi-managed/contracts — Skill & skill version resources.
 *
 * Mirrors docs/api-reference.md §"Skills". Pi has a native skills system (Agent Skills
 * standard). Pre-built (`pptx`, `xlsx`, `docx`, `pdf`) + custom. Upload is multipart.
 */

import { z } from "zod";
import { Timestamp } from "./common.js";
import { skillId } from "./ids.js";

export const SkillType = z.enum(["prebuilt", "custom"]);
export type SkillType = z.infer<typeof SkillType>;

export const SkillVersion = z.object({
  version: z.number().int().positive(),
  createdAt: Timestamp,
});
export type SkillVersion = z.infer<typeof SkillVersion>;

export const Skill = z.object({
  id: skillId,
  displayTitle: z.string(),
  type: SkillType,
  versions: z.array(SkillVersion),
  createdAt: Timestamp,
});
export type Skill = z.infer<typeof Skill>;

export const SkillListParams = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
  type: SkillType.optional(),
});
export type SkillListParams = z.infer<typeof SkillListParams>;
