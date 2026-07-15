/**
 * @pi-managed/client — API-key storage via Pi's AuthStorage (spec §24.5).
 *
 * Pi's `AuthStorage` is a provider-keyed credential store (`auth.json`). We
 * store the backend API key as an `api_key` credential under the `apiKeyRef`
 * provider id (default `pi-managed-backend`). The raw key never appears in
 * settings JSON — settings hold only `apiKeyRef`.
 *
 * `AuthStorageLike` is the minimal structural slice of Pi's `AuthStorage` we
 * depend on; the real class satisfies it, and `InMemoryAuthStore` is used in
 * tests. This keeps the module free of a runtime Pi dependency.
 */

import type { PiManagedSettings, ConfigEnv } from "./config.js";
import { ENV_API_KEY, ENV_BACKEND_URL } from "./config.js";

/** A stored credential (api_key form only — we never store OAuth here). */
export interface StoredApiKeyCredential {
  type: "api_key";
  key: string;
  env?: Record<string, string>;
}

/** Minimal structural slice of Pi's `AuthStorage`. */
export interface AuthStorageLike {
  get(provider: string): StoredApiKeyCredential | { type: "oauth" } | undefined;
  set(provider: string, credential: StoredApiKeyCredential): void;
  remove(provider: string): void;
}

/** Simple API-key store interface used by the client + commands. */
export interface AuthStore {
  get(ref: string): string | undefined;
  set(ref: string, apiKey: string): void;
  remove(ref: string): void;
}

/** Wraps Pi's `AuthStorage` (or any `AuthStorageLike`) as an API-key store. */
export class PiAuthStorageAdapter implements AuthStore {
  constructor(private readonly authStorage: AuthStorageLike) {}

  get(ref: string): string | undefined {
    const cred = this.authStorage.get(ref);
    if (cred && cred.type === "api_key") return cred.key;
    return undefined;
  }

  set(ref: string, apiKey: string): void {
    this.authStorage.set(ref, { type: "api_key", key: apiKey });
  }

  remove(ref: string): void {
    this.authStorage.remove(ref);
  }
}

/** In-memory store for tests and ephemeral runs. */
export class InMemoryAuthStore implements AuthStore {
  private readonly map = new Map<string, string>();
  get(ref: string): string | undefined {
    return this.map.get(ref);
  }
  set(ref: string, apiKey: string): void {
    this.map.set(ref, apiKey);
  }
  remove(ref: string): void {
    this.map.delete(ref);
  }
}

/**
 * Resolve the effective backend API key.
 * Precedence: `PI_MANAGED_API_KEY` env > AuthStorage (under `apiKeyRef`).
 */
export function resolveApiKey(
  config: PiManagedSettings,
  store: AuthStore,
  env: ConfigEnv = process.env,
): string | undefined {
  if (env[ENV_API_KEY]) return env[ENV_API_KEY];
  return store.get(config.apiKeyRef);
}

/** Resolve the effective backend URL (env > settings). */
export function resolveBackendUrl(
  config: PiManagedSettings,
  env: ConfigEnv = process.env,
): string | undefined {
  return env[ENV_BACKEND_URL] ?? config.backendUrl;
}
