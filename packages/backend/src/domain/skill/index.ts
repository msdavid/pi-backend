/**
 * Skills domain barrel (WP-3.5, §8.10, §20).
 *
 * Skill CRUD + versioning (`skill.ts`), pre-built per-tenant seeding (`seed.ts`),
 * session-skill materialization (`materialize.ts`), and `/skill:name` RPC
 * invocability (`rpc.ts`). Bundle zip parsing is in `zip.ts` (no new deps).
 */

export {
  toSkill,
  uploadSkill,
  listSkills,
  getSkill,
  listVersions,
  deleteSkill,
  fetchSkillRow,
  fetchVersionRows,
  latestVersion,
  readBundle,
  findSkillMd,
  deriveSkillName,
  deriveDisplayTitle,
  normalizeBundlePaths,
  collectBundleFiles,
  skillBundlePrefix,
  skillManifestKey,
  isZipBuffer,
  extractZipEntries,
  type SkillRow,
  type SkillVersionRow,
  type BundleFile,
  type BundleManifest,
  type ReadBundle,
  type UploadSkillInput,
  type ZipEntry,
} from "./skill.js";

export {
  seedPrebuiltSkills,
  defaultPrebuiltSeeds,
  prebuiltBundle,
  PREBUILT_SKILL_NAMES,
  type PrebuiltSeed,
} from "./seed.js";

export {
  resolveSessionSkills,
  materializeSessionSkillsToDirectory,
  buildSkillsOverride,
  toPiSkills,
  MAX_SKILLS_PER_SESSION,
  type ResolvedSkill,
  type ManagedSkill,
} from "./materialize.js";

export {
  skillCommand,
  assertSkillInvokable,
} from "./rpc.js";
