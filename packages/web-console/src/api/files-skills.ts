/**
 * `/v1/files` + `/v1/skills` families — fetchers + hooks (WP-C3-prep
 * skeleton; the files/skills read surfaces, console-spec §9.5 remainder /
 * journey W14, are WP-C3.6). One module for the two small read-mostly
 * families (same file-size rationale as `sessions.ts`' splits, inverted).
 *
 * Mirrors `contracts/src/file.ts` + `contracts/src/skill.ts` and
 * api-reference §"Files" / §"Skills". Reads: files list (cursor-paginated,
 * `?sessionId=`), file metadata, content download (same-origin `<a href>` —
 * {@link fileContentDownloadUrl}); skills list (cursor-paginated, `?type=`),
 * skill detail, skill versions (`{data}` only — NO `nextCursor` field on
 * this endpoint, api-reference §"Cursor pagination" small-collections note).
 * Writes per API: DELETE (hard) for both.
 *
 * NOT modeled here (verified against api-reference — both uploads are
 * multipart forms, which the JSON `ConsoleApiClient` deliberately does not
 * speak): `POST /v1/files` and `POST /v1/skills`. The §9.5 screens are
 * list/detail/content per API; if a feature WP needs in-console upload, that
 * is a client-wrapper extension to design then — not a fetcher to improvise
 * here.
 */

import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Cursor,
  File,
  Skill,
  SkillVersion,
  type SkillType,
} from "@pi-managed/contracts";
import { apiClient, type ConsoleApi, type ResponseSchema } from "./client.js";
import { fileKeys, skillKeys } from "./keys.js";
import { useApiClient } from "./provider.js";
import { cursorPageParams, withQuery } from "./pagination.js";

const FilePage = Cursor(File);
const SkillPage = Cursor(Skill);

/** Filters for `GET /v1/files` (`?sessionId=` + pagination). */
export interface FileListFilters {
  limit?: number;
  sessionId?: string;
}

/** Filters for `GET /v1/skills` (`?type=` + pagination). */
export interface SkillListFilters {
  limit?: number;
  type?: SkillType;
}

/** `GET /v1/skills/:id/versions` returns `{data}` with NO `nextCursor`. */
export interface SkillVersionsList {
  data: SkillVersion[];
}

const SkillVersionsListSchema: ResponseSchema<SkillVersionsList> = {
  parse(input: unknown): SkillVersionsList {
    const data = (input as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) {
      throw new Error("skill versions: expected { data: [...] }");
    }
    return { data: data.map((item) => SkillVersion.parse(item)) };
  },
};

/**
 * The cookie-authed same-origin download URL for a file's content
 * (api-reference §"GET /v1/files/:id/content"). Rendered as a plain
 * `<a href>` like `sessionOutputDownloadUrl` — the console-session cookie
 * rides every same-origin GET.
 */
export function fileContentDownloadUrl(id: string): string {
  return `/v1/files/${encodeURIComponent(id)}/content`;
}

// --- Fetchers ---------------------------------------------------------------

/** `GET /v1/files` — one page of the cursor-paginated list. */
export function listFiles(
  params: FileListFilters & { cursor?: string } = {},
  client: ConsoleApi = apiClient,
): Promise<Cursor<File>> {
  return client.get(withQuery("/v1/files", { ...params }), FilePage);
}

/** `GET /v1/files/:id` — retrieve metadata. */
export function getFile(
  id: string,
  client: ConsoleApi = apiClient,
): Promise<File> {
  return client.get(`/v1/files/${encodeURIComponent(id)}`, File);
}

/** `DELETE /v1/files/:id` — hard delete (§21). */
export function deleteFile(
  id: string,
  client: ConsoleApi = apiClient,
): Promise<void> {
  return client.del(`/v1/files/${encodeURIComponent(id)}`);
}

/** `GET /v1/skills` — one page of the cursor-paginated list. */
export function listSkills(
  params: SkillListFilters & { cursor?: string } = {},
  client: ConsoleApi = apiClient,
): Promise<Cursor<Skill>> {
  return client.get(withQuery("/v1/skills", { ...params }), SkillPage);
}

/** `GET /v1/skills/:id` — retrieve. */
export function getSkill(
  id: string,
  client: ConsoleApi = apiClient,
): Promise<Skill> {
  return client.get(`/v1/skills/${encodeURIComponent(id)}`, Skill);
}

/** `GET /v1/skills/:id/versions` — the full version list (no cursor). */
export function listSkillVersions(
  id: string,
  client: ConsoleApi = apiClient,
): Promise<SkillVersionsList> {
  return client.get(
    `/v1/skills/${encodeURIComponent(id)}/versions`,
    SkillVersionsListSchema,
  );
}

/** `DELETE /v1/skills/:id` — hard delete. */
export function deleteSkill(
  id: string,
  client: ConsoleApi = apiClient,
): Promise<void> {
  return client.del(`/v1/skills/${encodeURIComponent(id)}`);
}

// --- Query options + hooks ----------------------------------------------------

export function filesInfiniteOptions(
  filters: FileListFilters = {},
  client: ConsoleApi = apiClient,
) {
  return infiniteQueryOptions({
    queryKey: fileKeys.list(filters),
    queryFn: ({ pageParam }) =>
      listFiles({ ...filters, cursor: pageParam }, client),
    ...cursorPageParams,
  });
}

/** Cursor-paginated files list (C§9.5). */
export function useFiles(filters: FileListFilters = {}) {
  return useInfiniteQuery(filesInfiniteOptions(filters, useApiClient()));
}

export function fileOptions(id: string, client: ConsoleApi = apiClient) {
  return queryOptions({
    queryKey: fileKeys.detail(id),
    queryFn: () => getFile(id, client),
  });
}

export function useFile(id: string) {
  return useQuery(fileOptions(id, useApiClient()));
}

/** Hard-delete a file (`write` scope — backend `requireScopeByMethod`;
 * the DP-7 dialog is the caller's job). */
export function useDeleteFile() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteFile(id, client),
    onSuccess: (_void, id) => {
      queryClient.removeQueries({ queryKey: fileKeys.detail(id) });
      void queryClient.invalidateQueries({ queryKey: fileKeys.lists() });
    },
  });
}

export function skillsInfiniteOptions(
  filters: SkillListFilters = {},
  client: ConsoleApi = apiClient,
) {
  return infiniteQueryOptions({
    queryKey: skillKeys.list(filters),
    queryFn: ({ pageParam }) =>
      listSkills({ ...filters, cursor: pageParam }, client),
    ...cursorPageParams,
  });
}

/** Cursor-paginated skills list (C§9.5). */
export function useSkills(filters: SkillListFilters = {}) {
  return useInfiniteQuery(skillsInfiniteOptions(filters, useApiClient()));
}

export function skillOptions(id: string, client: ConsoleApi = apiClient) {
  return queryOptions({
    queryKey: skillKeys.detail(id),
    queryFn: () => getSkill(id, client),
  });
}

export function useSkill(id: string) {
  return useQuery(skillOptions(id, useApiClient()));
}

export function skillVersionsOptions(
  id: string,
  client: ConsoleApi = apiClient,
) {
  return queryOptions({
    queryKey: skillKeys.versions(id),
    queryFn: () => listSkillVersions(id, client),
  });
}

export function useSkillVersions(id: string) {
  return useQuery(skillVersionsOptions(id, useApiClient()));
}

/** Hard-delete a skill (`write` scope — backend `requireScopeByMethod`;
 * the DP-7 dialog is the caller's job). */
export function useDeleteSkill() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteSkill(id, client),
    onSuccess: (_void, id) => {
      queryClient.removeQueries({ queryKey: skillKeys.detail(id) });
      void queryClient.invalidateQueries({ queryKey: skillKeys.lists() });
    },
  });
}
