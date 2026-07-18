/**
 * `/v1/files` + `/v1/skills` families of the {@link FakeConsoleApi}
 * (WP-C3-prep). Read + delete only, like the console's own surface (uploads
 * are multipart and not modeled — see `src/api/files-skills.ts`).
 */
import type { File, Skill } from "@pi-managed/contracts";

import { notFound, pageOf } from "./wire.js";

/** A full wire-shaped file (contracts `File`). */
export function makeFile(overrides: Partial<File> & { id: string }): File {
  return {
    name: "report.pdf",
    contentType: "application/pdf",
    sizeBytes: 1024,
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A full wire-shaped skill (contracts `Skill`). */
export function makeSkill(overrides: Partial<Skill> & { id: string }): Skill {
  return {
    displayTitle: "PDF toolkit",
    type: "custom",
    versions: [{ version: 1, createdAt: "2026-07-01T00:00:00.000Z" }],
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

/** The slice of `FakeConsoleApi` state these families use. */
export interface FilesSkillsState {
  files: File[];
  skills: Skill[];
}

/** `GET /v1/files*` + `GET /v1/skills*`; `undefined` if unmatched. */
export function filesSkillsGet(
  state: FilesSkillsState,
  pathname: string,
  params: URLSearchParams,
): unknown | undefined {
  if (pathname === "/v1/files") {
    const sessionId = params.get("sessionId");
    const matches = state.files.filter(
      (f) => !sessionId || f.sessionId === sessionId,
    );
    return pageOf(matches, params);
  }
  const file = pathname.match(/^\/v1\/files\/([^/]+)$/);
  if (file) {
    const id = decodeURIComponent(file[1]!);
    const found = state.files.find((f) => f.id === id);
    if (!found) throw notFound(id);
    return found;
  }
  if (pathname === "/v1/skills") {
    const type = params.get("type");
    const matches = state.skills.filter((s) => !type || s.type === type);
    return pageOf(matches, params);
  }
  const skill = pathname.match(/^\/v1\/skills\/([^/]+)(?:\/(versions))?$/);
  if (skill) {
    const id = decodeURIComponent(skill[1]!);
    const found = state.skills.find((s) => s.id === id);
    if (!found) throw notFound(id);
    // Versions: `{data}` only — no nextCursor field on this endpoint.
    if (skill[2] === "versions") return { data: found.versions };
    return found;
  }
  return undefined;
}

/** `DELETE /v1/files/:id` + `DELETE /v1/skills/:id`; `false` if unmatched. */
export function filesSkillsDel(
  state: FilesSkillsState,
  pathname: string,
): boolean {
  const file = pathname.match(/^\/v1\/files\/([^/]+)$/);
  if (file) {
    const id = decodeURIComponent(file[1]!);
    const found = state.files.find((f) => f.id === id);
    if (!found) throw notFound(id);
    state.files.splice(state.files.indexOf(found), 1);
    return true;
  }
  const skill = pathname.match(/^\/v1\/skills\/([^/]+)$/);
  if (skill) {
    const id = decodeURIComponent(skill[1]!);
    const found = state.skills.find((s) => s.id === id);
    if (!found) throw notFound(id);
    state.skills.splice(state.skills.indexOf(found), 1);
    return true;
  }
  return false;
}
