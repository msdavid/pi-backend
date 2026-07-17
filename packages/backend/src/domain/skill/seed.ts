/**
 * Pre-built skill seeding (§20.1).
 *
 * The default skill set shipped with v1 — `pptx`, `xlsx`, `docx`, `pdf` (the
 * standard document-task set) — is seeded **per tenant**. Seeding is
 * idempotent: a pre-built skill already present for the tenant is skipped. Each
 * seeded skill gets a minimal `SKILL.md` bundle stored in the object store + a
 * version-1 row.
 */

import {
  tenantScopedQuery,
  type Pool,
  type TenantCtx,
  type QueryResultRow,
} from "../../infra/db/index.js";
import { ApiError } from "../errors.js";
import type { ObjectStore } from "../ports.js";
import type { Skill } from "@pi-managed/contracts";
import {
  uploadSkill,
  getSkill,
  type BundleFile,
} from "./skill.js";

/** The default pre-built skill set. */
export const PREBUILT_SKILL_NAMES = ["pptx", "xlsx", "docx", "pdf"] as const;

/** A seeded pre-built skill entry + its minimal `SKILL.md` content. */
export interface PrebuiltSeed {
  name: string;
  title: string;
  description: string;
  instructions: string;
}

/**
 * The default pre-built skill seeds. Content is minimal but valid: a frontmatter
 * block (`name` + `description`) followed by a short instructions body — enough
 * for Pi's loader to register the skill and for `/skill:name` to surface it.
 */
export function defaultPrebuiltSeeds(): PrebuiltSeed[] {
  const doc = (name: string, title: string, ext: string, kind: string): PrebuiltSeed => ({
    name,
    title,
    description: `Create and edit ${kind} documents.`,
    instructions: [
      `# ${title}`,
      "",
      `This skill guides the agent in producing and revising ${kind} (.${ext}) files.`,
      "Always validate structure before returning the file to the caller.",
      "",
    ].join("\n"),
  });
  return [
    doc("pptx", "PowerPoint", "pptx", "PowerPoint presentation"),
    doc("xlsx", "Spreadsheet", "xlsx", "Excel spreadsheet"),
    doc("docx", "Word Document", "docx", "Word document"),
    doc("pdf", "PDF", "pdf", "PDF document"),
  ];
}

/** Render a {@link PrebuiltSeed} as a `SKILL.md` bundle (single file). */
export function prebuiltBundle(seed: PrebuiltSeed): BundleFile[] {
  const md =
    "---\n" +
    `name: ${seed.name}\n` +
    `description: ${seed.description}\n` +
    "---\n\n" +
    seed.instructions;
  return [{ path: "SKILL.md", data: Buffer.from(md, "utf8") }];
}

/**
 * Seed the pre-built skills for a tenant. Idempotent: skills already present
 * (by `display_title` + `type='prebuilt'`) are skipped. Returns the skills that
 * were created (or already present) for the tenant.
 */
export async function seedPrebuiltSkills(
  pool: Pool,
  tenantCtx: TenantCtx,
  store: ObjectStore,
): Promise<Skill[]> {
  const seeds = defaultPrebuiltSeeds();
  const result: Skill[] = [];
  for (const seed of seeds) {
    // Idempotency: skip if a prebuilt skill with this title already exists.
    const existingId = await fetchPrebuiltIdByTitle(pool, tenantCtx, seed.title);
    if (existingId) {
      const skill = await getSkill(pool, tenantCtx, existingId);
      if (!skill) {
        throw new ApiError(500, "internal_error", `seeded skill disappeared: ${existingId}`);
      }
      result.push(skill);
      continue;
    }
    const skill = await uploadSkill(pool, tenantCtx, store, {
      files: prebuiltBundle(seed),
      displayTitle: seed.title,
      type: "prebuilt",
    });
    result.push(skill);
  }
  return result;
}

/** Fetch a prebuilt skill's id by `display_title` for the tenant. */
async function fetchPrebuiltIdByTitle(
  pool: Pool,
  tenantCtx: TenantCtx,
  displayTitle: string,
): Promise<string | null> {
  const { rows } = await tenantScopedQuery<{ id: string } & QueryResultRow>(
    pool,
    tenantCtx,
    `SELECT id FROM skills
      WHERE tenant_id = $1 AND display_title = $2 AND type = 'prebuilt'`,
    [tenantCtx.tenantId, displayTitle],
  );
  return rows[0]?.id ?? null;
}
