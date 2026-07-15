/**
 * Onboarding sign-up service (WP-5.2, §29.6, §24.3).
 *
 * The public entry point for the SaaS tenant-onboarding flow:
 * `POST /v1/onboarding/signup` (unauthenticated, gated by `onboarding.enabled`)
 * → creates a tenant + an admin API key (argon2id-hashed, shown once) and
 * returns the `pi install` command + backend URL the client needs to wire up
 * the managed extension (§29.6, §24.3).
 *
 * Idempotent on `adminEmail`: the {@link onboarding_signups} table maps an
 * admin email to exactly one tenant. A repeat sign-up (same email) reuses the
 * existing tenant but issues **no** credential (R0.3): the endpoint is public
 * and unauthenticated, so re-issuing an admin key to anyone who guesses a known
 * admin email is an unauthenticated tenant takeover. The response shape is the
 * same whether or not the tenant pre-existed — it differs only by the absence
 * of `apiKey` — so the response never leaks which emails already exist. No
 * duplicate tenant is ever created.
 */

import { z } from "zod";
import { query, type Pool } from "../../infra/db/index.js";
import { createTenant } from "../tenant/tenant.js";
import { issueApiKey, type IssuedApiKey } from "../tenant/api-key.js";

/** The default `pi install` command handed to a freshly-onboarded tenant (§29.6). */
export const DEFAULT_INSTALL_COMMAND = "pi install npm:@pi-managed/client";

/** The AuthStorage ref under which the client stores the backend API key (§24.5). */
export const DEFAULT_API_KEY_REF = "pi-managed-backend";

/** Sign-up request body (mirrors `POST /v1/onboarding/signup`, §29.6). */
export const SignupInputSchema = z.object({
  tenantName: z.string().min(1).max(128),
  adminEmail: z.string().email(),
  /**
   * The public base URL clients should use to reach the backend (used to build
   * the install instructions). Optional: callers (the route) may supply a
   * server-known default; the client ultimately overrides via `/remote:login`.
   */
  backendUrl: z.string().url().optional(),
});
export type SignupInput = z.infer<typeof SignupInputSchema>;

/** The install-instructions payload returned by sign-up (§29.6, §24.3). */
export interface SignupResult {
  tenantId: string;
  /**
   * The freshly issued admin key — raw key shown ONCE (stored hashed, §8).
   * **Absent** on a repeat sign-up for an existing `adminEmail`: no credential
   * is re-issued to a public, unauthenticated caller (R0.3).
   */
  apiKey?: IssuedApiKey;
  /** The backend URL clients should target. */
  backendUrl: string;
  /** `pi install …` command for the managed client extension (§29.6). */
  installCommand: string;
  /** The client-extension config block (§24.3): backendUrl + apiKeyRef. */
  extensionConfig: {
    backendUrl: string;
    apiKeyRef: string;
  };
}

/**
 * Resolve an existing tenant for `adminEmail`, or `null` if none is signed up.
 * Reads the idempotency table (not `tenants` directly) so the email→tenant
 * mapping is the single source of truth for sign-up idempotency.
 */
export async function tenantForEmail(
  pool: Pool,
  adminEmail: string,
): Promise<string | null> {
  const { rows } = await query<{ tenant_id: string }>(
    pool,
    "SELECT tenant_id FROM onboarding_signups WHERE admin_email = $1",
    [adminEmail],
  );
  return rows[0]?.tenant_id ?? null;
}

/**
 * Create a tenant + record the email→tenant link. Idempotent under concurrent
 * sign-ups: the `INSERT … ON CONFLICT (admin_email) DO NOTHING` ensures at most
 * one row per email; if a concurrent sign-up won the race, the existing tenant
 * is returned instead of the one we just created.
 *
 * Returns `{ tenantId, created }` — `created` is `true` when this call created
 * the tenant, `false` when a concurrent sign-up already had one (the
 * just-created tenant is then orphaned and harmless; the winning tenant wins).
 */
async function createTenantForSignup(
  pool: Pool,
  input: SignupInput,
): Promise<{ tenantId: string; created: boolean }> {
  // Fast path: an existing sign-up for this email reuses its tenant.
  const existing = await tenantForEmail(pool, input.adminEmail);
  if (existing) return { tenantId: existing, created: false };

  const tenant = await createTenant(pool, {
    name: input.tenantName,
    quotaPlan: "default",
  });
  const { rowCount } = await query(
    pool,
    `INSERT INTO onboarding_signups (admin_email, tenant_id)
       VALUES ($1, $2)
     ON CONFLICT (admin_email) DO NOTHING`,
    [input.adminEmail, tenant.id],
  );
  if ((rowCount ?? 0) > 0) {
    return { tenantId: tenant.id, created: true };
  }
  // Lost the race: a concurrent sign-up inserted first. Reuse its tenant.
  const winner = await tenantForEmail(pool, input.adminEmail);
  return { tenantId: winner ?? tenant.id, created: false };
}

/**
 * Sign up a new tenant (or reuse the existing one for `adminEmail`) and — only
 * when the tenant is freshly created — issue an admin API key. The raw key is
 * returned ONCE (stored hashed argon2id, §8).
 *
 * On a repeat sign-up with the same `adminEmail`, the existing tenant is reused
 * and **no** credential is issued (R0.3): the endpoint is public and
 * unauthenticated, so re-issuing an admin key would let anyone who knows a
 * tenant's admin email take it over. The returned `apiKey` is `undefined` in
 * that case; the rest of the response is identical to a first sign-up, so the
 * caller cannot tell from the shape whether the email already existed. No
 * duplicate tenant is created — the {@link onboarding_signups} table guarantees
 * email uniqueness.
 */
export async function signup(
  pool: Pool,
  input: SignupInput,
): Promise<SignupResult> {
  const { tenantId, created } = await createTenantForSignup(pool, input);

  // Issue a fresh admin key ONLY for a newly created tenant. For a pre-existing
  // tenant we return no credential — re-issuing to an unauthenticated caller is
  // a tenant takeover (R0.3). Scopes label this as the tenant's admin/bootstrap
  // key; scope enforcement is added in a later WP.
  const apiKey = created
    ? await issueApiKey(pool, { tenantId }, { name: "admin", scopes: ["admin"] })
    : undefined;

  const backendUrl =
    input.backendUrl ?? "https://api.pi-managed.example";

  return {
    tenantId,
    ...(apiKey ? { apiKey } : {}),
    backendUrl,
    installCommand: DEFAULT_INSTALL_COMMAND,
    extensionConfig: {
      backendUrl,
      apiKeyRef: DEFAULT_API_KEY_REF,
    },
  };
}
