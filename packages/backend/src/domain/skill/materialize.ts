/**
 * Session-skill materialization (WP-3.5, §20.3, §20.4).
 *
 * At session start, the agent(s)'s `skills[]` (a list of {@link SkillRef}) is
 * materialized into the session so Pi's native progressive-disclosure loading
 * applies unchanged. Two equivalent surfaces are provided:
 *
 * 1. **Directory materialization** — write each bundle under `.pi/skills/<name>/`
 *    inside the session workspace. Pi's `DefaultResourceLoader` discovers
 *    `.pi/skills/` natively (skills.md "Locations"), so progressive disclosure
 *    (name + description always in context; full `SKILL.md` loaded on demand)
 *    works with zero coupling to Pi internals.
 * 2. **`skillsOverride` materialization** — build a `Skill[]` for
 *    `new DefaultResourceLoader({ skillsOverride })` pointing at the staged files
 *    (sdk.md "Skills"). Use when the harness constructs the `AgentSession` with
 *    an explicit loader.
 *
 * **≤20 skills per session, counted across all agents (§20.3).** The per-agent
 * `AgentConfig.skills` already caps at 20 (contracts `agent.ts`); this enforces
 * the cross-agent session total.
 */

import { type Pool, type TenantCtx } from "../../infra/db/index.js";
import { ApiError } from "../errors.js";
import type { ObjectStore } from "../ports.js";
import type { SkillRef } from "@pi-managed/contracts";
import {
  fetchSkillRow,
  fetchVersionRows,
  latestVersion,
  readBundle,
  type BundleFile,
} from "./skill.js";

/** Max skills attachable to a single session across all agents (§20.3). */
export const MAX_SKILLS_PER_SESSION = 20;

/** A fully resolved skill ready to materialize into a session. */
export interface ResolvedSkill {
  skillId: string;
  /** Skill name (frontmatter `name` / H1); used as the on-disk dir name. */
  name: string;
  version: number;
  type: "prebuilt" | "custom";
  skillMdPath: string;
  files: BundleFile[];
}

/**
 * Resolve the `SkillRef` list for a session: enforce the ≤20 cap, resolve each
 * ref to a concrete version (explicit, else latest), and download the bundle
 * from the object store. Cross-tenant access is impossible (the skill/version
 * lookups are tenant-scoped). Duplicate refs are de-duplicated by `(skillId,
 * version)` while preserving first-seen order.
 */
export async function resolveSessionSkills(
  pool: Pool,
  tenantCtx: TenantCtx,
  store: ObjectStore,
  refs: SkillRef[],
): Promise<ResolvedSkill[]> {
  if (refs.length > MAX_SKILLS_PER_SESSION) {
    throw new ApiError(
      422,
      "invalid_request",
      `a session may attach at most ${MAX_SKILLS_PER_SESSION} skills (§20.3)`,
      { count: refs.length },
    );
  }
  const seen = new Set<string>();
  const out: ResolvedSkill[] = [];
  for (const ref of refs) {
    const key = `${ref.skillId}@${ref.version ?? "latest"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(await resolveOne(pool, tenantCtx, store, ref));
  }
  return out;
}

async function resolveOne(
  pool: Pool,
  tenantCtx: TenantCtx,
  store: ObjectStore,
  ref: SkillRef,
): Promise<ResolvedSkill> {
  const row = await fetchSkillRow(pool, tenantCtx, ref.skillId);
  if (!row) {
    throw new ApiError(404, "not_found", `skill not found: ${ref.skillId}`);
  }
  const versions = await fetchVersionRows(pool, tenantCtx, ref.skillId);
  if (versions.length === 0) {
    throw new ApiError(404, "not_found", `no versions for skill ${ref.skillId}`);
  }
  const chosen = ref.version
    ? versions.find((v) => v.version === ref.version)
    : latestVersion(versions);
  if (!chosen) {
    throw new ApiError(
      404,
      "not_found",
      `skill ${ref.skillId} has no version ${ref.version}`,
    );
  }
  const bundle = await readBundle(store, chosen.object_key);
  return {
    skillId: row.id,
    name: bundle.name,
    version: chosen.version,
    type: row.type as ResolvedSkill["type"],
    skillMdPath: bundle.skillMdPath,
    files: bundle.files,
  };
}

/**
 * Materialize resolved skills into a directory tree under `targetRoot`
 * (`.pi/skills/`). Each skill is written to `<targetRoot>/<name>/` with its
 * `SKILL.md` at the directory root (Pi discovery requires this). Returns the
 * staged skill directories + the on-disk `SKILL.md` paths. Existing dirs are
 * overwritten file-by-file.
 */
export async function materializeSessionSkillsToDirectory(
  resolved: ResolvedSkill[],
  targetRoot: string,
): Promise<Array<{ name: string; dir: string; skillMdPath: string }>> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  const staged: Array<{ name: string; dir: string; skillMdPath: string }> = [];
  for (const r of resolved) {
    const dir = join(targetRoot, sanitizeDirName(r.name));
    let skillMdAbs = join(dir, r.skillMdPath);
    for (const f of r.files) {
      const dest = join(dir, f.path);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, f.data);
      if (f.path === r.skillMdPath) skillMdAbs = dest;
    }
    staged.push({ name: r.name, dir, skillMdPath: skillMdAbs });
  }
  return staged;
}

/**
 * Build a `skillsOverride` `Skill[]` from staged skills (for
 * `new DefaultResourceLoader({ skillsOverride })`, sdk.md "Skills"). The skills
 * point at the on-disk `SKILL.md` paths produced by
 * {@link materializeSessionSkillsToDirectory}; Pi's loader reads the full
 * content on demand (progressive disclosure preserved).
 *
 * The `description` is read from the staged `SKILL.md` frontmatter; if absent,
 * the skill name is used. The `source` is `"managed"` so Pi surfaces these as
 * managed-backend-injected skills.
 */
export async function buildSkillsOverride(
  staged: Array<{ name: string; dir: string; skillMdPath: string }>,
): Promise<ManagedSkill[]> {
  const { readFile } = await import("node:fs/promises");
  const out: ManagedSkill[] = [];
  for (const s of staged) {
    const text = await readFile(s.skillMdPath, "utf8").catch(() => "");
    const description = readFrontmatterDescription(text) ?? s.name;
    out.push({
      name: s.name,
      description,
      filePath: s.skillMdPath,
      baseDir: s.dir,
      source: "managed",
      disableModelInvocation: false,
    });
  }
  return out;
}

/**
 * The managed-backend shape for an injected skill. Structurally compatible with
 * Pi's `Skill` ({@link createSyntheticSourceInfo} + the loader). The session
 * manager converts these to real `Skill` objects (with `sourceInfo`) when it
 * builds the `DefaultResourceLoader`; this decoupling keeps the skill domain
 * free of a Pi import for the directory path.
 */
export interface ManagedSkill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: string;
  disableModelInvocation: boolean;
}

/**
 * Convert {@link ManagedSkill}s into Pi `Skill[]` for the loader. The session
 * manager calls this when it constructs the `DefaultResourceLoader`; it is the
 * single point that imports Pi's skill types, keeping the domain module clean.
 */
export async function toPiSkills(
  skills: ManagedSkill[],
): Promise<ManagedSkill[]> {
  // Pure passthrough by design — the managed shape already matches Pi's `Skill`
  // modulo `sourceInfo`, which the session manager fills in via
  // `createSyntheticSourceInfo`. Kept as a seam for that conversion.
  return skills;
}

/**
 * The pool + object-store backed skill materializer (R6.5b) the composition root injects
 * into every {@link ManagedSessionRuntime}. Structurally satisfies the session manager's
 * `SkillMaterializer` seam. One call at wake: resolve the agent's `SkillRef[]` (≤20 per
 * session — {@link resolveSessionSkills} throws `422` past the cap), stage each bundle
 * under `<targetRoot>/<name>/`, and return the staged skills for the loader's
 * `skillsOverride` (progressive disclosure preserved — only name + description enter the
 * system prompt; `SKILL.md` is read on demand).
 */
export function createSkillMaterializer(deps: {
  pool: Pool;
  objectStore: ObjectStore;
}) {
  const { pool, objectStore } = deps;
  return {
    async materialize(
      tenantId: string,
      refs: SkillRef[],
      targetRoot: string,
    ): Promise<ManagedSkill[]> {
      if (refs.length === 0) return [];
      const resolved = await resolveSessionSkills(
        pool,
        { tenantId },
        objectStore,
        refs,
      );
      const staged = await materializeSessionSkillsToDirectory(resolved, targetRoot);
      return buildSkillsOverride(staged);
    },
  };
}

/** A simple, filesystem-safe dir name (lowercases, swaps non-[a-z0-9_-] for `-`). */
function sanitizeDirName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "skill";
}

/** Read `description` from a `SKILL.md` frontmatter block (best-effort). */
function readFrontmatterDescription(src: string): string | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src);
  if (!m) return null;
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    if (line.slice(0, i).trim() === "description") {
      let v = line.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      return v || null;
    }
  }
  return null;
}
