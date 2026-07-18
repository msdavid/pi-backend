/**
 * `/v1/vaults` family of the {@link FakeConsoleApi} (WP-C3-prep). Basic CRUD
 * in-memory. SECURITY INVARIANT (C§13 / §9.3): credential records NEVER
 * carry a secret field — `addCredential` shapes the response like the real
 * API (the write-only secret from the request body is discarded), so no
 * secret value can reach a fixture or DOM snapshot through this fake.
 */
import type { Credential, Vault } from "@pi-managed/contracts";

import { ConsoleApiError } from "../../api/client.js";
import { notFound, fullSet } from "./wire.js";

/** §12.4 duplicate key — like the real backend, archived rows count too
 * (the `(vault_id, key)` unique index has no status filter). */
function duplicateKey(key: string): ConsoleApiError {
  return new ConsoleApiError(`credential key already exists in vault: ${key}`, {
    status: 409,
    code: "conflict",
    type: "request_error",
    requestId: "req_01TESTREQUEST",
  });
}

/** A full wire-shaped vault (contracts `Vault`). */
export function makeVault(overrides: Partial<Vault> & { id: string }): Vault {
  return {
    name: "team-secrets",
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A wire-shaped credential RECORD (contracts `Credential` — no secret). */
export function makeCredential(
  overrides: Partial<Credential> & { vaultId: string; key: string },
): Credential {
  return {
    id: `vcred_01TEST${overrides.key.replace(/[^a-zA-Z0-9]/g, "").toUpperCase()}`,
    category: "static_bearer",
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

/** The slice of `FakeConsoleApi` state the vaults family uses. */
export interface VaultsState {
  vaults: Vault[];
  credentials: Map<string, Credential[]>;
  credentialValidation: "valid" | "invalid" | "unknown";
}

function findVault(state: VaultsState, id: string): Vault {
  const found = state.vaults.find((v) => v.id === id);
  if (!found) throw notFound(id);
  return found;
}

/** `GET /v1/vaults*` — the wire body, or `undefined` if unmatched. */
export function vaultsGet(
  state: VaultsState,
  pathname: string,
): unknown | undefined {
  if (pathname === "/v1/vaults") return fullSet(state.vaults);
  const match = pathname.match(/^\/v1\/vaults\/([^/]+)(?:\/(credentials))?$/);
  if (!match) return undefined;
  const vault = findVault(state, decodeURIComponent(match[1]!));
  if (match[2] === "credentials") {
    return fullSet(state.credentials.get(vault.id) ?? []);
  }
  return vault;
}

/** `POST /v1/vaults*` — create / archive / add credential / validate. */
export function vaultsPost(
  state: VaultsState,
  pathname: string,
  body: unknown,
): unknown | undefined {
  if (pathname === "/v1/vaults") {
    const { name } = body as { name: string };
    const vault = makeVault({
      id: `vault_01TESTNEW${state.vaults.length + 1}`,
      name,
    });
    state.vaults.push(vault);
    return vault;
  }
  const archive = pathname.match(/^\/v1\/vaults\/([^/]+)\/archive$/);
  if (archive) {
    const vault = findVault(state, decodeURIComponent(archive[1]!));
    vault.status = "archived";
    // Cascade (§12.7): credentials archived, secrets purged (none held here).
    for (const cred of state.credentials.get(vault.id) ?? []) {
      cred.status = "archived";
    }
    return vault;
  }
  const creds = pathname.match(/^\/v1\/vaults\/([^/]+)\/credentials$/);
  if (creds) {
    const vault = findVault(state, decodeURIComponent(creds[1]!));
    // Shape the RECORD from the request: keep key + category, DISCARD the
    // write-only secret fields (token/secretValue/accessToken/apiKey/…).
    const { key, category } = body as Credential;
    const all = state.credentials.get(vault.id) ?? [];
    if (all.some((c) => c.key === key)) throw duplicateKey(key);
    const record = makeCredential({ vaultId: vault.id, key, category });
    all.push(record);
    state.credentials.set(vault.id, all);
    return record;
  }
  const validate = pathname.match(
    /^\/v1\/vaults\/([^/]+)\/credentials\/([^/]+)\/validate$/,
  );
  if (validate) {
    findVault(state, decodeURIComponent(validate[1]!));
    return { status: state.credentialValidation };
  }
  return undefined;
}

/** `DELETE /v1/vaults/:id` + `DELETE …/credentials/:key`; `false` if unmatched. */
export function vaultsDel(state: VaultsState, pathname: string): boolean {
  const cred = pathname.match(/^\/v1\/vaults\/([^/]+)\/credentials\/([^/]+)$/);
  if (cred) {
    const vault = findVault(state, decodeURIComponent(cred[1]!));
    const key = decodeURIComponent(cred[2]!);
    const record = (state.credentials.get(vault.id) ?? []).find(
      (c) => c.key === key,
    );
    if (!record) throw notFound(key);
    record.status = "archived"; // secret purged; the key stays reserved
    return true;
  }
  const match = pathname.match(/^\/v1\/vaults\/([^/]+)$/);
  if (!match) return false;
  const vault = findVault(state, decodeURIComponent(match[1]!));
  state.vaults.splice(state.vaults.indexOf(vault), 1);
  state.credentials.delete(vault.id);
  return true;
}
