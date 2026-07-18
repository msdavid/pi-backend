/**
 * `/v1/onboarding` family — the public signup fetcher plus the first-run
 * checklist progress probe (WP-C3.7; console-spec §9.6 / journey W8).
 *
 * Mirrors api-reference §"POST /v1/onboarding/signup" (backend
 * `domain/onboarding/signup.ts`). Public/unauthenticated, gated by
 * `ONBOARDING_ENABLED` (`403 forbidden` when disabled — the console gates
 * the /signup route on `/console/config` first, C§5.3). First sign-up
 * creates a tenant + an admin API key; the raw key is shown ONCE (§9.6:
 * copy-and-confirm). A repeat sign-up for a known `adminEmail` reuses the
 * tenant and OMITS `apiKey` — the response shape never leaks which emails
 * exist, and the signup page renders that case ("check with your admin").
 *
 * No contracts schema exists for the response yet; validated structurally
 * below (`SessionOutputsListSchema` precedent) — the nested `apiKey`
 * delegates to the contracts `ApiKeyCreateResponse`.
 *
 * The first-run progress probe (DP-12, W8 §2) is a cross-family derived
 * read: it composes the real vaults/agents/sessions list fetchers to detect
 * each checklist step's completion (≥1 active `model_provider_key`
 * credential, ≥1 agent, ≥1 session). Its query key lives here — not in
 * `keys.ts` — because it is a checklist-only composition, not a resource
 * family of its own.
 */

import { useMutation, useQuery, queryOptions } from "@tanstack/react-query";
import { ApiKeyCreateResponse } from "@pi-managed/contracts";
import { listAgents } from "./agents.js";
import { apiClient, type ConsoleApi, type ResponseSchema } from "./client.js";
import { useApiClient } from "./provider.js";
import { listSessions } from "./sessions.js";
import { listCredentials, listVaults } from "./vaults.js";

/** Sign-up request body (api-reference §"POST /v1/onboarding/signup"). */
export interface SignupRequest {
  tenantName: string;
  adminEmail: string;
}

/** The install-instructions payload signup returns (`201`). */
export interface SignupResponse {
  tenantId: string;
  /** The freshly issued admin key — shown ONCE; ABSENT on repeat sign-up. */
  apiKey?: ApiKeyCreateResponse;
  backendUrl: string;
  /** `pi install …` command for the managed client extension (§29.6). */
  installCommand: string;
  extensionConfig: {
    backendUrl: string;
    apiKeyRef: string;
  };
}

const SignupResponseSchema: ResponseSchema<SignupResponse> = {
  parse(input: unknown): SignupResponse {
    const v = input as
      | {
          tenantId?: unknown;
          apiKey?: unknown;
          backendUrl?: unknown;
          installCommand?: unknown;
          extensionConfig?: { backendUrl?: unknown; apiKeyRef?: unknown };
        }
      | null;
    if (
      !v ||
      typeof v.tenantId !== "string" ||
      typeof v.backendUrl !== "string" ||
      typeof v.installCommand !== "string" ||
      typeof v.extensionConfig?.backendUrl !== "string" ||
      typeof v.extensionConfig?.apiKeyRef !== "string"
    ) {
      throw new Error("signup: unexpected response shape");
    }
    return {
      tenantId: v.tenantId,
      ...(v.apiKey !== undefined
        ? { apiKey: ApiKeyCreateResponse.parse(v.apiKey) }
        : {}),
      backendUrl: v.backendUrl,
      installCommand: v.installCommand,
      extensionConfig: {
        backendUrl: v.extensionConfig.backendUrl,
        apiKeyRef: v.extensionConfig.apiKeyRef,
      },
    };
  },
};

// --- Fetchers ---------------------------------------------------------------

/** `POST /v1/onboarding/signup` — public sign-up (`403` when disabled). */
export function signup(
  body: SignupRequest,
  client: ConsoleApi = apiClient,
): Promise<SignupResponse> {
  return client.post("/v1/onboarding/signup", body, SignupResponseSchema);
}

/** What the W8 first-run checklist has detected as done (DP-12). */
export interface FirstRunProgress {
  /** ≥1 ACTIVE `model_provider_key` credential in an active vault (§9.3:
   * sessions fail closed without one, DP-6). */
  hasModelProviderKey: boolean;
  /** ≥1 agent exists. */
  hasAgent: boolean;
  /** ≥1 session exists. */
  hasSession: boolean;
}

/**
 * Detect first-run checklist completion via the real APIs (W8 §2): one page
 * of agents/sessions (existence is a `limit: 1` probe) plus the vaults full
 * set, walking each active vault's credentials until a `model_provider_key`
 * is found (vaults are a small bounded collection, §9.3).
 */
export async function fetchFirstRunProgress(
  client: ConsoleApi = apiClient,
): Promise<FirstRunProgress> {
  const [vaults, agents, sessions] = await Promise.all([
    listVaults(client),
    listAgents({ limit: 1 }, client),
    listSessions({ limit: 1 }, client),
  ]);
  let hasModelProviderKey = false;
  for (const vault of vaults.data) {
    if (vault.status !== "active") continue;
    const credentials = await listCredentials(vault.id, client);
    if (
      credentials.data.some(
        (c) => c.category === "model_provider_key" && c.status === "active",
      )
    ) {
      hasModelProviderKey = true;
      break;
    }
  }
  return {
    hasModelProviderKey,
    hasAgent: agents.data.length > 0,
    hasSession: sessions.data.length > 0,
  };
}

// --- Query options + hooks ----------------------------------------------------

/** Checklist-local key (composition across families — deliberately not in
 * `keys.ts`; the checklist refetches on every mount instead of riding other
 * families' invalidations). */
export const firstRunKeys = {
  progress: () => ["onboarding", "first-run"] as const,
};

export function firstRunProgressOptions(client: ConsoleApi = apiClient) {
  return queryOptions({
    queryKey: firstRunKeys.progress(),
    queryFn: () => fetchFirstRunProgress(client),
  });
}

/** First-run checklist completion (W8 §2). Refetches whenever the checklist
 * remounts or the window regains focus — the steps are completed on OTHER
 * surfaces (vaults, agents, CLI), so returning to the checklist re-probes. */
export function useFirstRunProgress(opts: { enabled?: boolean } = {}) {
  const client = useApiClient();
  return useQuery({
    ...firstRunProgressOptions(client),
    refetchOnMount: "always",
    ...opts,
  });
}

// --- Hooks --------------------------------------------------------------------

/** Sign-up (W8). The raw admin key lives ONLY in the mutation result —
 * render once behind copy-and-confirm; nothing is cached. The signup page
 * renders OUTSIDE the auth gate but INSIDE the provider stack, so the
 * ordinary injection seam applies. */
export function useSignup() {
  const client = useApiClient();
  return useMutation({
    mutationFn: (body: SignupRequest) => signup(body, client),
  });
}
