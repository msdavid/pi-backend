/**
 * Skills domain service (WP-3.5, §8.10, §20, §3.8).
 *
 * Pi has a native skills system (the Agent Skills standard — `SKILL.md` + assets).
 * The managed backend stores skill bundles in the object store and metadata in
 * Postgres. A bundle is a set of objects under a version prefix
 * `tenants/<tenant>/skills/<skill_id>/v<version>/` plus a `manifest.json`; this
 * avoids any zip-writing dependency (the upload path extracts zips into objects,
 * the materialization path reads objects back out). Custom skills are unique by
 * `display_title` within a tenant (§20.2); pre-built skills are seeded per tenant
 * (§20.1, decisions.md).
 *
 * Every query routes through {@link tenantScopedQuery} so cross-tenant access is
 * impossible by construction (§27.1).
 */

import {
  tenantScopedQuery,
  type Pool,
  type TenantCtx,
} from "../../infra/db/index.js";
import { newId } from "../tenant/ids.js";
import { ApiError } from "../errors.js";
import type { ObjectStore } from "../ports.js";
import type { Skill, SkillType, SkillVersion } from "@pi-managed/contracts";
import { extractZipEntries, isZipBuffer, type ZipEntry } from "./zip.js";

// ---------------------------------------------------------------------------
// Object-store layout
// ---------------------------------------------------------------------------

/** Prefix for all objects of one skill version (§28 layout). */
export function skillBundlePrefix(
  tenantId: string,
  skillId: string,
  version: number,
): string {
  return `tenants/${tenantId}/skills/${skillId}/v${version}`;
}

/** Key for the version's manifest object (file index + derived skill name). */
export function skillManifestKey(prefix: string): string {
  return `${prefix}/manifest.json`;
}

// ---------------------------------------------------------------------------
// Row shapes & mapping
// ---------------------------------------------------------------------------

export interface SkillRow {
  id: string;
  display_title: string;
  type: string;
  created_at: Date;
}

export interface SkillVersionRow {
  skill_id: string;
  version: number;
  object_key: string;
  created_at: Date;
}

const iso = (d: Date): string => d.toISOString();

/** Build the wire {@link Skill} resource from a skill row + its version rows. */
export function toSkill(row: SkillRow, versions: SkillVersionRow[]): Skill {
  const sorted = [...versions].sort((a, b) => a.version - b.version);
  const wireVersions: SkillVersion[] = sorted.map((v) => ({
    version: v.version,
    createdAt: iso(v.created_at),
  }));
  return {
    id: row.id,
    displayTitle: row.display_title,
    type: row.type as SkillType,
    versions: wireVersions,
    createdAt: iso(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// Bundle helpers (object store)
// ---------------------------------------------------------------------------

/** A single file within a skill bundle (relative path + content). */
export interface BundleFile {
  path: string;
  data: Buffer;
}

/** Stored manifest: the file index + the derived skill name + SKILL.md path. */
export interface BundleManifest {
  name: string;
  skillMdPath: string;
  files: Array<{ path: string; size: number }>;
}

/** Result of {@link readBundle}: the resolved files + manifest. */
export interface ReadBundle {
  name: string;
  skillMdPath: string;
  files: BundleFile[];
}

/**
 * Normalize + sanitize bundle-relative paths. Rejects absolute paths and any
 * `..` segment so a malicious bundle cannot escape its prefix (§27). Strips a
 * single leading `./` and collapses the common `name/` top directory so the
 * SKILL.md sits at the bundle root.
 */
export function normalizeBundlePaths(files: BundleFile[]): BundleFile[] {
  const out: BundleFile[] = [];
  for (const f of files) {
    const p = f.path.replace(/\\/g, "/").replace(/^\.\//, "");
    if (p.startsWith("/")) {
      throw new ApiError(422, "invalid_request", `absolute bundle path not allowed: ${f.path}`);
    }
    const segs = p.split("/");
    if (segs.includes("..")) {
      throw new ApiError(422, "invalid_request", `bundle path traversal not allowed: ${f.path}`);
    }
    // Drop a single common top-level directory (zips typically wrap a root dir).
    out.push({ path: p, data: f.data });
  }
  return out;
}

/**
 * Find the `SKILL.md` entry. Accepts it at the bundle root or one directory deep
 * (the common zip-wrapper case); deeper nesting is rejected (Agent Skills
 * standard: SKILL.md sits at the skill root).
 */
export function findSkillMd(files: BundleFile[]): BundleFile | null {
  const direct = files.find((f) => f.path === "SKILL.md");
  if (direct) return direct;
  const oneDeep = files.find((f) => /^[^/]+\/SKILL\.md$/.test(f.path));
  return oneDeep ?? null;
}

/**
 * Derive a skill `name` + `displayTitle` from `SKILL.md` content. Order:
 * frontmatter `name` → frontmatter `title` → first H1 heading → `null`.
 */
export function deriveSkillName(skillMd: string): string | null {
  const fm = parseFrontmatter(skillMd);
  if (fm.name && fm.name.trim()) return fm.name.trim();
  if (fm.title && fm.title.trim()) return fm.title.trim();
  const h1 = /^#\s+(.+?)\s*$/m.exec(skillMd);
  if (h1 && h1[1].trim()) return h1[1].trim();
  return null;
}

/**
 * Derive the user-facing `displayTitle` (§20.2) from `SKILL.md` content when the
 * caller omits it. Falls back to the skill name, then `null`.
 */
export function deriveDisplayTitle(skillMd: string): string | null {
  return deriveSkillName(skillMd);
}

/** Parse a minimal YAML frontmatter block (`---\n…\n---`). Returns top-level keys. */
function parseFrontmatter(src: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k) out[k] = v;
  }
  return out;
}

/**
 * Flatten a zip buffer + any accompanying loose files into one normalized
 * bundle-file list. When the primary `file` part is a zip, its entries replace
 * the loose files (mixed zip + loose is rejected as ambiguous).
 */
export function collectBundleFiles(
  zip: Buffer | null,
  loose: BundleFile[],
): BundleFile[] {
  if (zip && loose.length > 0) {
    throw new ApiError(
      422,
      "invalid_request",
      "upload either a single zip or individual files, not both",
    );
  }
  if (zip) {
    const entries = extractZipEntries(zip);
    return normalizeBundlePaths(entries);
  }
  return normalizeBundlePaths(loose);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Fetch a skill row, or `null` if absent / cross-tenant. */
export async function fetchSkillRow(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
): Promise<SkillRow | null> {
  const { rows } = await tenantScopedQuery<SkillRow>(
    pool,
    tenantCtx,
    `SELECT * FROM skills WHERE tenant_id = $1 AND id = $2`,
    [tenantCtx.tenantId, id],
  );
  return rows[0] ?? null;
}

/** Fetch a custom skill by display title, or `null` if absent. */
export async function fetchCustomSkillByTitle(
  pool: Pool,
  tenantCtx: TenantCtx,
  displayTitle: string,
): Promise<SkillRow | null> {
  const { rows } = await tenantScopedQuery<SkillRow>(
    pool,
    tenantCtx,
    `SELECT * FROM skills
      WHERE tenant_id = $1 AND type = 'custom' AND display_title = $2`,
    [tenantCtx.tenantId, displayTitle],
  );
  return rows[0] ?? null;
}

/** Fetch all version rows for a skill (cross-tenant-safe). */
export async function fetchVersionRows(
  pool: Pool,
  tenantCtx: TenantCtx,
  skillId: string,
): Promise<SkillVersionRow[]> {
  const { rows } = await tenantScopedQuery<SkillVersionRow>(
    pool,
    tenantCtx,
    `SELECT * FROM skill_versions WHERE tenant_id = $1 AND skill_id = $2
      ORDER BY version ASC`,
    [tenantCtx.tenantId, skillId],
  );
  return rows;
}

/** Batch-fetch version rows for many skill ids (one round-trip). */
export async function fetchVersionRowsForSkills(
  pool: Pool,
  tenantCtx: TenantCtx,
  skillIds: string[],
): Promise<Map<string, SkillVersionRow[]>> {
  const map = new Map<string, SkillVersionRow[]>();
  if (skillIds.length === 0) return map;
  const { rows } = await tenantScopedQuery<SkillVersionRow>(
    pool,
    tenantCtx,
    `SELECT * FROM skill_versions
      WHERE tenant_id = $1 AND skill_id = ANY($2::text[])
      ORDER BY version ASC`,
    [tenantCtx.tenantId, skillIds],
  );
  for (const r of rows) {
    const list = map.get(r.skill_id) ?? [];
    list.push(r);
    map.set(r.skill_id, list);
  }
  return map;
}

/** Resolve the latest (max) version row. */
export function latestVersion(rows: SkillVersionRow[]): SkillVersionRow {
  if (rows.length === 0) throw new Error("latestVersion: empty");
  return rows.reduce((a, b) => (a.version > b.version ? a : b));
}

/**
 * Read a stored bundle from the object store: fetch + parse the manifest, then
 * fetch each file. `objectKey` is the version prefix stored in
 * `skill_versions.object_key`.
 */
export async function readBundle(
  store: ObjectStore,
  objectKey: string,
): Promise<ReadBundle> {
  const manifestStream = await store.get(skillManifestKey(objectKey));
  const manifestBytes = await drain(manifestStream);
  let manifest: BundleManifest;
  try {
    manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8"));
  } catch {
    throw new ApiError(500, "internal_error", `corrupt skill manifest at ${objectKey}`);
  }
  const files: BundleFile[] = [];
  for (const entry of manifest.files) {
    const stream = await store.get(`${objectKey}/${entry.path}`);
    files.push({ path: entry.path, data: Buffer.from(await drain(stream)) });
  }
  return {
    name: manifest.name,
    skillMdPath: manifest.skillMdPath,
    files,
  };
}

/** Get a skill (with versions); `null` if absent / cross-tenant. */
export async function getSkill(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
): Promise<Skill | null> {
  const row = await fetchSkillRow(pool, tenantCtx, id);
  if (!row) return null;
  const versions = await fetchVersionRows(pool, tenantCtx, id);
  return toSkill(row, versions);
}

/** List skills for the tenant, newest first, cursor-paginated, optional type filter. */
export async function listSkills(
  pool: Pool,
  tenantCtx: TenantCtx,
  opts: { limit: number; cursor?: string; type?: SkillType },
): Promise<{ data: Skill[]; nextCursor: string | null }> {
  const where: string[] = [];
  const params: unknown[] = [tenantCtx.tenantId];
  let n = 1;
  if (opts.type) {
    where.push(`type = $${++n}`);
    params.push(opts.type);
  }
  if (opts.cursor) {
    const { createdAt, id } = decodeListCursor(opts.cursor);
    where.push(`(created_at, id) < ($${++n}, $${++n})`);
    params.push(createdAt, id);
  }
  params.push(opts.limit + 1);
  const { rows } = await tenantScopedQuery<SkillRow>(
    pool,
    tenantCtx,
    `SELECT * FROM skills
      WHERE tenant_id = $1 ${where.length ? `AND ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC, id DESC
      LIMIT $${++n}`,
    params,
  );
  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  const versions = await fetchVersionRowsForSkills(
    pool,
    tenantCtx,
    page.map((r) => r.id),
  );
  const data = page.map((r) => toSkill(r, versions.get(r.id) ?? []));
  const nextCursor =
    hasMore && page.length > 0
      ? encodeListCursor(page[page.length - 1])
      : null;
  return { data, nextCursor };
}

/** List versions for a skill. */
export async function listVersions(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
): Promise<SkillVersion[]> {
  const row = await fetchSkillRow(pool, tenantCtx, id);
  if (!row) {
    throw new ApiError(404, "not_found", `skill not found: ${id}`);
  }
  const versions = await fetchVersionRows(pool, tenantCtx, id);
  return versions
    .sort((a, b) => a.version - b.version)
    .map((v) => ({ version: v.version, createdAt: iso(v.created_at) }));
}

// ---------------------------------------------------------------------------
// Upload (create skill, version 1)
// ---------------------------------------------------------------------------

export interface UploadSkillInput {
  /** Already-flattened bundle files (zip extracted or loose files). */
  files: BundleFile[];
  /** Optional; derived from `SKILL.md` if omitted (§20.2). */
  displayTitle?: string;
  /** Skill type; `custom` for API uploads, `prebuilt` for seeding. */
  type?: SkillType;
}

/**
 * Upload a skill: normalize the bundle, derive + uniqueness-check the
 * `displayTitle` (§20.2, custom only), store the bundle objects + manifest, and
 * insert the `skills` + `skill_versions` rows (version 1). Returns the wire
 * resource.
 */
export async function uploadSkill(
  pool: Pool,
  tenantCtx: TenantCtx,
  store: ObjectStore,
  input: UploadSkillInput,
): Promise<Skill> {
  const type: SkillType = input.type ?? "custom";
  const skillMd = findSkillMd(input.files);
  if (!skillMd) {
    throw new ApiError(422, "invalid_request", "skill bundle must contain a SKILL.md");
  }
  const skillMdText = skillMd.data.toString("utf8");
  const displayTitle =
    input.displayTitle?.trim() || deriveDisplayTitle(skillMdText);
  if (!displayTitle || displayTitle.length > 128) {
    throw new ApiError(
      422,
      "invalid_request",
      "displayTitle could not be derived or exceeds 128 chars",
    );
  }
  if (type === "custom") {
    const existing = await fetchCustomSkillByTitle(pool, tenantCtx, displayTitle);
    if (existing) {
      throw new ApiError(409, "conflict", `skill "${displayTitle}" already exists`, {
        skillId: existing.id,
      });
    }
  }

  const id = newId("skill_");
  const version = 1;
  const prefix = skillBundlePrefix(tenantCtx.tenantId, id, version);
  const name = deriveSkillName(skillMdText) ?? displayTitle;

  // Strip the wrapper directory so SKILL.md sits at the bundle root.
  const root = skillMd.path === "SKILL.md" ? "" : skillMd.path.slice(0, -"SKILL.md".length);
  const rootedFiles: BundleFile[] = input.files.map((f) => ({
    path: f.path.startsWith(root) ? f.path.slice(root.length) : f.path,
    data: f.data,
  }));

  const manifest: BundleManifest = {
    name,
    skillMdPath: "SKILL.md",
    files: [],
  };
  for (const f of rootedFiles) {
    const key = `${prefix}/${f.path}`;
    await store.put(key, new Response(f.data).body as ReadableStream<Uint8Array>);
    manifest.files.push({ path: f.path, size: f.data.byteLength });
  }
  await store.put(
    skillManifestKey(prefix),
    new Response(JSON.stringify(manifest)).body as ReadableStream<Uint8Array>,
  );

  await tenantScopedQuery(
    pool,
    tenantCtx,
    `INSERT INTO skills (tenant_id, id, display_title, type) VALUES ($1, $2, $3, $4)`,
    [tenantCtx.tenantId, id, displayTitle, type],
  );
  await tenantScopedQuery(
    pool,
    tenantCtx,
    `INSERT INTO skill_versions (tenant_id, skill_id, version, object_key)
     VALUES ($1, $2, $3, $4)`,
    [tenantCtx.tenantId, id, version, prefix],
  );

  const now = new Date();
  return toSkill(
    { id, display_title: displayTitle, type, created_at: now },
    [{ skill_id: id, version, object_key: prefix, created_at: now }],
  );
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Hard-delete a skill: drop all version rows + objects, then the skill row.
 * Returns `true` if a skill was deleted, `false` if absent / cross-tenant.
 * Object-store purging is best-effort (a store failure after the rows are gone
 * leaves orphaned objects; the resource is deleted for the client).
 */
export async function deleteSkill(
  pool: Pool,
  tenantCtx: TenantCtx,
  store: ObjectStore,
  id: string,
): Promise<boolean> {
  const row = await fetchSkillRow(pool, tenantCtx, id);
  if (!row) return false;
  const versions = await fetchVersionRows(pool, tenantCtx, id);
  // Purge objects first (best-effort); then drop rows so the resource disappears.
  for (const v of versions) {
    try {
      await purgeBundleObjects(store, v.object_key);
    } catch {
      // Orphaned objects — the resource is deleted; auditable but non-fatal.
    }
  }
  await tenantScopedQuery(
    pool,
    tenantCtx,
    `DELETE FROM skill_versions WHERE tenant_id = $1 AND skill_id = $2`,
    [tenantCtx.tenantId, id],
  );
  await tenantScopedQuery(
    pool,
    tenantCtx,
    `DELETE FROM skills WHERE tenant_id = $1 AND id = $2`,
    [tenantCtx.tenantId, id],
  );
  return true;
}

/** Best-effort prefix purge: list + delete every object under the version prefix. */
async function purgeBundleObjects(store: ObjectStore, prefix: string): Promise<void> {
  for await (const obj of store.list(`${prefix}/`)) {
    await store.delete(obj.key);
  }
}

// ---------------------------------------------------------------------------
// Cursors + helpers
// ---------------------------------------------------------------------------

function encodeListCursor(row: SkillRow): string {
  return Buffer.from(
    JSON.stringify({ createdAt: iso(row.created_at), id: row.id }),
    "utf8",
  ).toString("base64url");
}

function decodeListCursor(cursor: string): { createdAt: string; id: string } {
  const json = Buffer.from(cursor, "base64url").toString("utf8");
  const parsed = JSON.parse(json) as { createdAt?: string; id?: string };
  if (!parsed.createdAt || !parsed.id) {
    throw new ApiError(400, "invalid_request", "invalid skill list cursor");
  }
  return { createdAt: parsed.createdAt, id: parsed.id };
}

/** Drain a `ReadableStream<Uint8Array>` into a `Buffer`. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

// Re-export zip helpers used by the upload route.
export { isZipBuffer, extractZipEntries, type ZipEntry };
