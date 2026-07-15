/**
 * Cross-node refresh coordination (R5.5, §12.5).
 *
 * Two nodes can independently decide the same mcp_oauth credential is expired
 * and refresh it at the same time. Because the token endpoint ROTATES the
 * refresh_token on every successful exchange (RFC 6749 §6), a naive second
 * refresh would POST the now-rotated-away refresh_token and get `invalid_grant`,
 * bricking the credential.
 *
 * {@link refreshOAuthToken} serializes refresh per credential across nodes with
 * a Postgres transaction-scoped advisory lock: the second refresh blocks until
 * the first commits, then re-loads the rotated row and REUSES the fresh token
 * instead of spending the stale one.
 *
 * This test fires two concurrent refreshes against a mock token endpoint that
 * rotates the refresh_token, sleeps 50ms, and rejects any stale refresh_token
 * with `invalid_grant`. It asserts exactly one net refresh reaches the endpoint,
 * both callers observe the same fresh access token, and the credential is not
 * bricked.
 *
 * SEC-3: the token POST runs through the SSRF-pinned transport, so the mock
 * endpoint is a mock `fetchImpl` (the final wire hop) reached via an https
 * `tokenUrl` that resolves to a public IP — the same seam the billing/webhook
 * sinks use. The advisory-lock coordination under test is unchanged.
 *
 * Uses a real Postgres (testcontainers); skips without a container runtime.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPool,
  closePool,
  query,
  runMigrations,
  type Pool,
  type TenantCtx,
} from "../../../infra/db/index.js";
import { createVaultCrypto, type VaultCrypto } from "../crypto.js";
import { refreshOAuthToken, RefreshError, type FetchImpl } from "../refresh.js";
import type { PinnedDnsResolver } from "../../net/ssrf-pin.js";
import { addCredential } from "../credential.js";
import { createVault } from "../vault.js";
import { startPostgres, hasContainerRuntime } from "../../../infra/db/__tests__/test-runtime.js";

const TENANT: TenantCtx = { tenantId: "tnt_refresh_concurrency" };
const CRYPTO: VaultCrypto = createVaultCrypto(Buffer.alloc(32, 7), "test");
const RUNTIME = hasContainerRuntime();

const TOKEN_URL = "https://oauth.concurrency.test/token";
const PROBE_KEY = "https://mcp.concurrency.test/probe";
const PUBLIC_RESOLVER: PinnedDnsResolver = async () => [
  { address: "93.184.216.34", family: 4 },
];

/**
 * A mock OAuth token endpoint (as a `fetchImpl`) that rotates the refresh_token
 * on every success, sleeps 50ms (widening the concurrency window), and rejects a
 * stale (already rotated) refresh_token with `invalid_grant` — exactly what
 * bricks a credential when two nodes refresh without coordination.
 */
interface RotatingTokenState {
  /** Number of successful net refreshes served. */
  successCount: number;
  /** True if any request presented a stale/rotated-away refresh_token. */
  sawStaleGrant: boolean;
}

function makeRotatingTokenFetch(initialRefreshToken: string): {
  state: RotatingTokenState;
  fetchImpl: FetchImpl;
} {
  const inner = { current: initialRefreshToken, counter: 0 };
  const state: RotatingTokenState = { successCount: 0, sawStaleGrant: false };
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const presented = new URLSearchParams(body).get("refresh_token");
    if (presented !== inner.current) {
      // Stale refresh_token — this is the brick path.
      state.sawStaleGrant = true;
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 });
    }
    // Valid grant: rotate, then respond after a 50ms delay.
    inner.counter += 1;
    const nextRefresh = `RT_${inner.counter}`;
    const nextAccess = `AT_${inner.counter}`;
    inner.current = nextRefresh;
    state.successCount += 1;
    await new Promise((r) => setTimeout(r, 50));
    return new Response(
      JSON.stringify({
        access_token: nextAccess,
        expires_in: 3600,
        refresh_token: nextRefresh,
      }),
      { status: 200 },
    );
  }) as unknown as FetchImpl;
  return { state, fetchImpl };
}

describe("refresh cross-node coordination (R5.5)", () => {
  let db: Awaited<ReturnType<typeof startPostgres>>;
  let pool: Pool;

  beforeAll(async () => {
    if (!RUNTIME) return;
    db = await startPostgres();
    await runMigrations(db.connectionString, "up");
    pool = createPool({ connectionString: db.connectionString });
    await query(
      pool,
      `INSERT INTO tenants (id, name) VALUES ($1, 'Refresh Concurrency Test') ON CONFLICT DO NOTHING`,
      [TENANT.tenantId],
    );
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  }, 120_000);

  /** Create an mcp_oauth credential whose access token is already expired. */
  async function setupExpiredOauthCred(refreshToken: string) {
    const vault = await createVault(pool, TENANT, {
      name: `oauth-cc-${Math.random().toString(36).slice(2)}`,
      metadata: undefined,
    });
    const key = PROBE_KEY;
    await addCredential(pool, TENANT, CRYPTO, vault.id, {
      key,
      category: "mcp_oauth",
      accessToken: "AT_OLD",
      refreshToken,
      refresh: {
        method: "client_secret_post",
        tokenUrl: TOKEN_URL,
        clientId: "cid",
        clientSecret: "csec",
      },
    });
    // Force the payload to look already-expired so the fresh-reuse short-circuit
    // is driven purely by the peer's committed refresh, not a pre-existing
    // future expiry.
    const row = await query<{ secret_enc: Buffer; nonce: Buffer; key_id: string }>(
      pool,
      `SELECT secret_enc, nonce, key_id FROM vault_credentials
        WHERE tenant_id = $1 AND vault_id = $2 AND key = $3`,
      [TENANT.tenantId, vault.id, key],
    );
    const payload = JSON.parse(
      CRYPTO.decrypt({
        ciphertext: row.rows[0].secret_enc,
        nonce: row.rows[0].nonce,
        keyId: row.rows[0].key_id,
      }),
    );
    payload.expiresAt = new Date(Date.now() - 60_000).toISOString();
    const enc = CRYPTO.encrypt(JSON.stringify(payload));
    await query(
      pool,
      `UPDATE vault_credentials SET secret_enc = $3, nonce = $4, key_id = $5
        WHERE tenant_id = $1 AND vault_id = $2 AND key = $6`,
      [TENANT.tenantId, vault.id, enc.ciphertext, enc.nonce, enc.keyId, key],
    );
    return { vaultId: vault.id, key };
  }

  async function readPayload(vaultId: string, key: string) {
    const row = await query<{ secret_enc: Buffer; nonce: Buffer; key_id: string }>(
      pool,
      `SELECT secret_enc, nonce, key_id FROM vault_credentials
        WHERE tenant_id = $1 AND vault_id = $2 AND key = $3`,
      [TENANT.tenantId, vaultId, key],
    );
    return JSON.parse(
      CRYPTO.decrypt({
        ciphertext: row.rows[0].secret_enc,
        nonce: row.rows[0].nonce,
        keyId: row.rows[0].key_id,
      }),
    ) as { accessToken: string; refreshToken?: string; expiresAt?: string };
  }

  it.skipIf(!RUNTIME)(
    "two concurrent refreshes → exactly one net refresh, the other reuses it (not bricked)",
    async () => {
      const { state, fetchImpl } = makeRotatingTokenFetch("RT_0");
      const { vaultId, key } = await setupExpiredOauthCred("RT_0");

      const doRefresh = () =>
        refreshOAuthToken(
          { pool, tenantCtx: TENANT, crypto: CRYPTO, locator: { vaultId, key } },
          { fetchImpl, dnsResolver: PUBLIC_RESOLVER },
        );

      const results = await Promise.allSettled([doRefresh(), doRefresh()]);

      // Neither refresh failed — no invalid_grant from a stale refresh token.
      for (const r of results) {
        if (r.status === "rejected") {
          throw new Error(
            `refresh rejected: ${(r.reason as RefreshError)?.message ?? String(r.reason)}`,
          );
        }
      }
      // Exactly one net refresh reached the token endpoint; the peer reused it.
      expect(state.successCount).toBe(1);
      expect(state.sawStaleGrant).toBe(false);

      // Both callers observe the same fresh access token (the one the winner
      // rotated to).
      const [a, b] = results as PromiseFulfilledResult<{ accessToken: string }>[];
      expect(a.value.accessToken).toBe("AT_1");
      expect(b.value.accessToken).toBe("AT_1");

      // The credential is not bricked: the stored payload is decryptable and
      // holds the winner's rotated refresh token + fresh access token.
      const payload = await readPayload(vaultId, key);
      expect(payload.accessToken).toBe("AT_1");
      expect(payload.refreshToken).toBe("RT_1");
    },
    60_000,
  );
});
