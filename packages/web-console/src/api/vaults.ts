/**
 * `/v1/vaults` family — fetchers + hooks (WP-C3-prep skeleton; the vaults &
 * credentials surface, console-spec §9.3 / journey W11, is WP-C3.3).
 *
 * Mirrors `contracts/src/vault.ts` and api-reference §"Vaults". Reads: list
 * (small bounded collection — the full set with `nextCursor: null`, no
 * paging), detail, credentials list (records WITHOUT sensitive fields).
 * Writes (admin scope): create vault, archive (cascades: credentials
 * archived, secrets purged — name it in the DP-7 dialog), DELETE (hard), add
 * credential by category, archive credential (`DELETE …/credentials/:key` —
 * purges the secret; NOTE the `(vault, key)` unique index includes archived
 * rows, so the key stays reserved — a WP-C3.3 contract-test finding against
 * api-reference §12.7's "freed for a replacement"), validate.
 *
 * SECURITY INVARIANT (§9.3, C§13): sensitive fields (`token`, `accessToken`,
 * `refreshToken`, `clientSecret`, `secretValue`, `apiKey`) exist ONLY in the
 * `CredentialCreate` request union — the `Credential` response schema has no
 * such fields, so a response that carried one would be stripped at this
 * seam. The UI never echoes or retains what the user typed after submit.
 */

import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Credential,
  Cursor,
  Vault,
  type CredentialCreate,
  type CredentialValidateResponse,
  type VaultCreate,
} from "@pi-managed/contracts";
import { apiClient, type ConsoleApi, type ResponseSchema } from "./client.js";
import { vaultKeys } from "./keys.js";
import { useApiClient } from "./provider.js";

const VaultPage = Cursor(Vault);
const CredentialPage = Cursor(Credential);

/**
 * `POST …/validate` response: `{status: "valid" | "invalid" | "unknown"}`
 * (api-reference §12.5). Contracts pins the value enum
 * (`CredentialValidateResponse`); the `{status}` wrapper has no schema yet,
 * so it is validated structurally here (same precedent as
 * `SessionOutputsListSchema` in `./sessions.ts`).
 */
export interface CredentialValidation {
  status: CredentialValidateResponse;
}

const CredentialValidationSchema: ResponseSchema<CredentialValidation> = {
  parse(input: unknown): CredentialValidation {
    const status = (input as { status?: unknown } | null)?.status;
    if (status !== "valid" && status !== "invalid" && status !== "unknown") {
      throw new Error("credential validate: expected { status: valid|invalid|unknown }");
    }
    return { status };
  },
};

// --- Fetchers ---------------------------------------------------------------

/** `GET /v1/vaults` — the full set (`nextCursor` is always `null`). */
export function listVaults(
  client: ConsoleApi = apiClient,
): Promise<Cursor<Vault>> {
  return client.get("/v1/vaults", VaultPage);
}

/** `GET /v1/vaults/:id` — retrieve. */
export function getVault(
  id: string,
  client: ConsoleApi = apiClient,
): Promise<Vault> {
  return client.get(`/v1/vaults/${encodeURIComponent(id)}`, Vault);
}

/** `GET /v1/vaults/:id/credentials` — records WITHOUT sensitive fields. */
export function listCredentials(
  id: string,
  client: ConsoleApi = apiClient,
): Promise<Cursor<Credential>> {
  return client.get(
    `/v1/vaults/${encodeURIComponent(id)}/credentials`,
    CredentialPage,
  );
}

/** `POST /v1/vaults` — create (admin). */
export function createVault(
  body: VaultCreate,
  client: ConsoleApi = apiClient,
): Promise<Vault> {
  return client.post("/v1/vaults", body, Vault);
}

/** `POST /v1/vaults/:id/archive` — cascades to credentials (secrets purged). */
export function archiveVault(
  id: string,
  client: ConsoleApi = apiClient,
): Promise<Vault> {
  return client.post(`/v1/vaults/${encodeURIComponent(id)}/archive`, {}, Vault);
}

/** `DELETE /v1/vaults/:id` — hard delete (no record retained, §12.7). */
export function deleteVault(
  id: string,
  client: ConsoleApi = apiClient,
): Promise<void> {
  return client.del(`/v1/vaults/${encodeURIComponent(id)}`);
}

/** `POST /v1/vaults/:id/credentials` — add by category; the secret fields in
 * `body` are write-only and never come back (the response is a `Credential`
 * record without them). */
export function addCredential(
  id: string,
  body: CredentialCreate,
  client: ConsoleApi = apiClient,
): Promise<Credential> {
  return client.post(
    `/v1/vaults/${encodeURIComponent(id)}/credentials`,
    body,
    Credential,
  );
}

/** `DELETE /v1/vaults/:id/credentials/:key` — archive the credential: the
 * secret is purged; the archived record keeps the key reserved (the `200`
 * body is the archived record; discarded here — the list is refetched). */
export function deleteCredential(
  id: string,
  key: string,
  client: ConsoleApi = apiClient,
): Promise<void> {
  return client.del(
    `/v1/vaults/${encodeURIComponent(id)}/credentials/${encodeURIComponent(key)}`,
  );
}

/** `POST /v1/vaults/:id/credentials/:key/validate` — OAuth status (§12.5):
 * `invalid` = grant gone → prompt re-auth; `unknown` = transient → retry. */
export function validateCredential(
  id: string,
  key: string,
  client: ConsoleApi = apiClient,
): Promise<CredentialValidation> {
  return client.post(
    `/v1/vaults/${encodeURIComponent(id)}/credentials/${encodeURIComponent(key)}/validate`,
    {},
    CredentialValidationSchema,
  );
}

// --- Query options + hooks ----------------------------------------------------

export function vaultsOptions(client: ConsoleApi = apiClient) {
  return queryOptions({
    queryKey: vaultKeys.list(),
    queryFn: () => listVaults(client),
  });
}

/** The tenant's vaults — a small bounded set, one query (C§9.3). */
export function useVaults() {
  return useQuery(vaultsOptions(useApiClient()));
}

export function vaultOptions(id: string, client: ConsoleApi = apiClient) {
  return queryOptions({
    queryKey: vaultKeys.detail(id),
    queryFn: () => getVault(id, client),
  });
}

export function useVault(id: string) {
  return useQuery(vaultOptions(id, useApiClient()));
}

export function credentialsOptions(id: string, client: ConsoleApi = apiClient) {
  return queryOptions({
    queryKey: vaultKeys.credentials(id),
    queryFn: () => listCredentials(id, client),
  });
}

/** One vault's credential records (no secret ever crosses this seam). */
export function useCredentials(id: string) {
  return useQuery(credentialsOptions(id, useApiClient()));
}

/** Create a vault (admin). */
export function useCreateVault() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: VaultCreate) => createVault(body, client),
    onSuccess: (vault) => {
      queryClient.setQueryData(vaultKeys.detail(vault.id), vault);
      void queryClient.invalidateQueries({ queryKey: vaultKeys.lists() });
    },
  });
}

/** Archive a vault (admin; DP-7 — the dialog names the credential cascade). */
export function useArchiveVault(id: string) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => archiveVault(id, client),
    onSuccess: () => {
      // The cascade also archives every credential — refresh the subtree.
      void queryClient.invalidateQueries({ queryKey: vaultKeys.detail(id) });
      void queryClient.invalidateQueries({ queryKey: vaultKeys.lists() });
    },
  });
}

/** Hard-delete a vault (admin). */
export function useDeleteVault(id: string) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => deleteVault(id, client),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: vaultKeys.detail(id) });
      void queryClient.invalidateQueries({ queryKey: vaultKeys.lists() });
    },
  });
}

/** Add a credential (admin). The submitted secret is not retained anywhere —
 * the mutation variables die with the mutation cache entry. */
export function useAddCredential(id: string) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CredentialCreate) => addCredential(id, body, client),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: vaultKeys.credentials(id) }),
  });
}

/** Archive a credential (admin; purges the secret, keeps the key reserved). */
export function useDeleteCredential(id: string) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => deleteCredential(id, key, client),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: vaultKeys.credentials(id) }),
  });
}

/** Validate a credential's OAuth status (admin). */
export function useValidateCredential(id: string) {
  const client = useApiClient();
  return useMutation({
    mutationFn: (key: string) => validateCredential(id, key, client),
  });
}
