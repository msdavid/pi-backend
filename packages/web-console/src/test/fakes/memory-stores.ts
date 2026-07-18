/**
 * `/v1/memory-stores` family of the {@link FakeConsoleApi} (state lives on
 * the main class; this module holds the maker + route handling).
 */
import type { Memory, MemoryStore, MemoryVersion } from "@pi-managed/contracts";

import { ConsoleApiError } from "../../api/client.js";
import { notFound, pageOf } from "./wire.js";

/** A restore that conflicts (`409`): the version's content is gone (redacted)
 * or the memory has an incompatible tombstone — like the real backend
 * (`restoreVersion`, api-reference §"…/restore"). */
function restoreConflict(versionId: string): ConsoleApiError {
  return new ConsoleApiError(
    `version ${versionId} cannot be restored: it conflicts with the current memory state`,
    {
      status: 409,
      code: "conflict",
      type: "request_error",
      requestId: "req_01TESTREQUEST",
    },
  );
}

/** A full wire-shaped memory store (contracts `MemoryStore`). */
export function makeMemoryStore(
  overrides: Partial<MemoryStore> & { id: string },
): MemoryStore {
  return {
    displayTitle: "Project conventions",
    instructions: "Follow the existing patterns.",
    access: "read_write",
    status: "active",
    mountPath: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

/** The slice of `FakeConsoleApi` state the memory-stores family reads. */
export interface MemoryStoresState {
  memoryStores: MemoryStore[];
  memories: Map<string, Memory[]>;
  memoryVersions: Map<string, MemoryVersion[]>;
  /** The id the next restore creates (WP-C4.0b). */
  nextRestoredVersionId: string;
  /** An intact version whose restore nonetheless answers `409 conflict`. */
  restoreConflictVersionId: string | null;
}

/** `GET /v1/memory-stores*` — the wire body, or `undefined` if unmatched. */
export function memoryStoresGet(
  state: MemoryStoresState,
  pathname: string,
  params: URLSearchParams,
): unknown | undefined {
  if (pathname === "/v1/memory-stores") {
    return pageOf(state.memoryStores, params);
  }
  const match = pathname.match(
    /^\/v1\/memory-stores\/([^/]+)(?:\/(memories|versions)(?:\/(.+))?)?$/,
  );
  if (!match) return undefined;
  const id = decodeURIComponent(match[1]!);
  const found = state.memoryStores.find((s) => s.id === id);
  if (!found) throw notFound(id);
  const [, , family, member] = match;
  if (family === "memories") {
    const all = state.memories.get(id) ?? [];
    if (member !== undefined) {
      const memoryPath = decodeURIComponent(member);
      const memory = all.find((m) => m.path === memoryPath);
      if (!memory) throw notFound(memoryPath);
      return memory;
    }
    // List view strips content — the wire returns summaries only.
    return pageOf(
      all.map(({ content: _content, ...summary }) => summary),
      params,
    );
  }
  if (family === "versions") {
    const all = state.memoryVersions.get(id) ?? [];
    if (member !== undefined) {
      const versionId = decodeURIComponent(member);
      const version = all.find((v) => v.id === versionId);
      if (!version) throw notFound(versionId);
      return version;
    }
    const memoryPath = params.get("memoryPath");
    const matches = memoryPath
      ? all.filter((v) => v.memoryPath === memoryPath)
      : all;
    return pageOf(matches, params);
  }
  return found;
}

/**
 * `POST /v1/memory-stores/:id/versions/:v/restore` (WP-C4.0b) — the wire
 * body (`201` on the real backend), or `undefined` if unmatched. Mirrors
 * the real op: redacted source → `409 conflict`; otherwise a NEW version
 * for the same `memoryPath` with the source's `contentSha256`, unshifted
 * at the newest-first head.
 */
export function memoryStoresPost(
  state: MemoryStoresState,
  pathname: string,
): unknown | undefined {
  const match = pathname.match(
    /^\/v1\/memory-stores\/([^/]+)\/versions\/([^/]+)\/restore$/,
  );
  if (!match) return undefined;
  const id = decodeURIComponent(match[1]!);
  if (!state.memoryStores.some((s) => s.id === id)) throw notFound(id);
  const versionId = decodeURIComponent(match[2]!);
  const all = state.memoryVersions.get(id) ?? [];
  const source = all.find((v) => v.id === versionId);
  if (!source) throw notFound(versionId);
  // Redacted versions have their Restore button disabled (unreachable 409);
  // `restoreConflictVersionId` designates an INTACT version that still
  // conflicts, exercising the reachable ErrorAlert path (F7).
  if (source.redacted || versionId === state.restoreConflictVersionId) {
    throw restoreConflict(versionId);
  }
  const created: MemoryVersion = {
    id: state.nextRestoredVersionId,
    memoryPath: source.memoryPath,
    contentSha256: source.contentSha256,
    redacted: false,
    createdAt: "2026-07-04T00:00:00.000Z",
    expiresAt: null,
  };
  all.unshift(created);
  state.memoryVersions.set(id, all);
  return created;
}
