/**
 * Vault refresh / validate / re-resolution tests (WP-2.4, §12.3, §12.5).
 *
 * Uses a real Postgres (testcontainers) + a Node `http` mock server for the
 * OAuth token endpoint and the MCP probe endpoint. Skips without a container
 * runtime (mirrors vault.test.ts). The pure parser/auth-header tests run always.
 *
 * Done criteria covered:
 * - refresh: expiry → refresh → new token (all 3 reachable auth-method paths,
 *   with `client_secret_basic`/`client_secret_post` exercised end-to-end against
 *   the mock; `none` is unreachable per the shared contract — see report).
 * - refresh failure → `vault_credential.refresh_failed` webhook event.
 * - re-resolution: rotate (archive + re-resolve) mid-session → next
 *   `resolveBindingsForSession` reflects the change without a restart.
 * - validate taxonomy: valid (2xx) / invalid (401) / unknown (5xx, 429, network).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import {
  createPool,
  closePool,
  query,
  runMigrations,
  type Pool,
  type TenantCtx,
} from "../../../infra/db/index.js";
import {
  createVaultCrypto,
  type VaultCrypto,
} from "../crypto.js";
import { createVaultSecretStore } from "../secret-store.js";
import {
  refreshOAuthToken,
  RefreshError,
  authorizationHeader,
  buildRefreshBody,
  parseTokenResponse,
  type FetchImpl,
} from "../refresh.js";
import { validateCredential } from "../validate.js";
import { addCredential } from "../credential.js";
import { createVault } from "../vault.js";
import type { WebhookEvent, WebhookSink } from "../../ports.js";
import type { PinnedDnsResolver } from "../../net/ssrf-pin.js";

const TENANT: TenantCtx = { tenantId: "tnt_vault_refresh_test" };
const TEST_KEY = Buffer.alloc(32, 9);
const CRYPTO: VaultCrypto = createVaultCrypto(TEST_KEY, "test");

// SEC-3: the token POST now runs through the SSRF-pinned transport, which
// requires an https `tokenUrl` resolving to a PUBLIC IP. Tests use a hostname
// endpoint + a resolver that returns a public address + a mock `fetchImpl` for
// the final wire hop — the same seam the billing/webhook sinks use. This keeps
// the scheme/port checks + public-IP assertion in `safeFetchPinned` running for
// real while the response body is scripted per-case.
const TOKEN_URL = "https://oauth.test.local/token";
const PUBLIC_RESOLVER: PinnedDnsResolver = async () => [
  { address: "93.184.216.34", family: 4 },
];

/**
 * Build a mock `fetchImpl` for the token endpoint. The handler sees the
 * Authorization header + urlencoded body `safeFetchPinned` forwards and returns
 * the scripted `{status, json}` response.
 */
function mockTokenFetch(
  handler: (auth: string, body: string) => { status: number; json: unknown },
): FetchImpl {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const body = typeof init?.body === "string" ? init.body : "";
    const { status, json } = handler(auth, body);
    return new Response(JSON.stringify(json), { status });
  }) as unknown as FetchImpl;
}

import {
  startPostgres,
  hasContainerRuntime,
} from "../../../infra/db/__tests__/test-runtime.js";

const RUNTIME = hasContainerRuntime();

// ---------------------------------------------------------------------------
// In-memory webhook sink (records `vault_credential.refresh_failed` events).
// ---------------------------------------------------------------------------

class MemoryWebhookSink implements WebhookSink {
  readonly events: WebhookEvent[] = [];
  async dispatch(event: WebhookEvent): Promise<void> {
    this.events.push(event);
  }
}

// ---------------------------------------------------------------------------
// Mock HTTP server for the /probe (MCP server probe) hop used by `validate`.
// The OAuth /token hop is exercised through the SSRF-pinned transport via a mock
// `fetchImpl` (see `mockTokenFetch`), so it is NOT served here.
// ---------------------------------------------------------------------------

interface MockServer {
  server: Server;
  baseUrl: string;
  /** Settable handler; tests mutate this per-case. */
  probeHandler: (req: IncomingMessage, res: ServerResponse) => void;
}

function startMockServer(): Promise<MockServer> {
  return new Promise((resolve) => {
    const mock: MockServer = {
      server: undefined as unknown as Server,
      baseUrl: "",
      probeHandler: (_req, res) => {
        res.statusCode = 200;
        res.end();
      },
    };
    const server = createServer((req, res) => {
      mock.probeHandler(req, res);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      mock.server = server;
      mock.baseUrl = `http://127.0.0.1:${port}`;
      resolve(mock);
    });
  });
}

// ---------------------------------------------------------------------------
// Pure unit tests (no DB / no server — always run).
// ---------------------------------------------------------------------------

describe("refresh: pure helpers", () => {
  it("authorizationHeader: client_secret_basic base64-encodes client:secret", () => {
    const h = authorizationHeader("client_secret_basic", "cid", "csec");
    expect(h).toBe(`Basic ${Buffer.from("cid:csec", "latin1").toString("base64")}`);
  });

  it("authorizationHeader: client_secret_post returns no header", () => {
    expect(authorizationHeader("client_secret_post", "cid", "csec")).toBeUndefined();
  });

  it("buildRefreshBody: client_secret_post puts creds in the body", () => {
    const body = buildRefreshBody("client_secret_post", "rt", "cid", "csec");
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=rt");
    expect(body).toContain("client_id=cid");
    expect(body).toContain("client_secret=csec");
  });

  it("buildRefreshBody: client_secret_basic omits creds from the body", () => {
    const body = buildRefreshBody("client_secret_basic", "rt", "cid", "csec");
    expect(body).toContain("refresh_token=rt");
    expect(body).not.toContain("client_secret");
    expect(body).not.toContain("client_id");
  });

  it("parseTokenResponse: success → access token + skew-adjusted expiry", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const r = parseTokenResponse(
      200,
      JSON.stringify({ access_token: "AT2", expires_in: 3600, refresh_token: "RT2" }),
      now,
    );
    expect(r.accessToken).toBe("AT2");
    expect(r.rotatedRefreshToken).toBe(true);
    // 30s skew window.
    expect(Date.parse(r.expiresAt!)).toBe(now.getTime() + (3600 - 30) * 1000);
  });

  it("parseTokenResponse: 4xx invalid_grant → invalid (retry = false)", () => {
    expect(() =>
      parseTokenResponse(401, JSON.stringify({ error: "invalid_grant" })),
    ).toThrow(/invalid_grant/);
    try {
      parseTokenResponse(400, JSON.stringify({ error: "invalid_grant" }));
    } catch (e) {
      expect((e as RefreshError).kind).toBe("invalid");
    }
  });

  it("parseTokenResponse: 5xx/429 → transient (retry)", () => {
    for (const status of [500, 503, 429]) {
      try {
        parseTokenResponse(status, JSON.stringify({ error: "temporarily_unavailable" }));
      } catch (e) {
        expect((e as RefreshError).kind).toBe("transient");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Integration tests (real Postgres + mock HTTP server).
// ---------------------------------------------------------------------------

describe("vault refresh / validate / revalidate", () => {
  let db: Awaited<ReturnType<typeof startPostgres>>;
  let pool: Pool;
  let mock: MockServer;

  beforeAll(async () => {
    if (!RUNTIME) return;
    db = await startPostgres();
    await runMigrations(db.connectionString, "up");
    pool = createPool({ connectionString: db.connectionString });
    await query(
      pool,
      `INSERT INTO tenants (id, name) VALUES ($1, 'Vault Refresh Test') ON CONFLICT DO NOTHING`,
      [TENANT.tenantId],
    );
    mock = await startMockServer();
  }, 120_000);

  afterAll(async () => {
    if (mock?.server) await new Promise<void>((r) => mock.server.close(() => r()));
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  }, 120_000);

  /** Create a vault + mcp_oauth credential with a refresh block. */
  async function setupOauthCred(opts: {
    method: "client_secret_basic" | "client_secret_post";
    refreshToken?: string;
    clientSecret?: string;
    accessToken?: string;
    expiresAt?: string;
  }) {
    const vault = await createVault(pool, TENANT, {
      name: `oauth-${Math.random().toString(36).slice(2)}`,
      metadata: undefined,
    });
    const vaultId = vault.id;
    await addCredential(pool, TENANT, CRYPTO, vaultId, {
      key: `${mock.baseUrl}/probe`,
      category: "mcp_oauth",
      accessToken: opts.accessToken ?? "AT_OLD",
      refreshToken: opts.refreshToken ?? "RT_OLD",
      refresh: {
        method: opts.method,
        // https + public-resolving host so the SSRF-pinned token POST is allowed
        // (the mock `fetchImpl` handles the final hop; SEC-3).
        tokenUrl: TOKEN_URL,
        clientId: "cid",
        clientSecret: opts.clientSecret ?? "csec",
      },
    });
    // If an expiry was requested, inject it into the encrypted payload directly
    // (the create API doesn't accept expiresAt — it's derived on refresh).
    if (opts.expiresAt) {
      const row = await query<{ secret_enc: Buffer; nonce: Buffer; key_id: string }>(
        pool,
        `SELECT secret_enc, nonce, key_id FROM vault_credentials
          WHERE tenant_id = $1 AND vault_id = $2 AND key = $3`,
        [TENANT.tenantId, vaultId, `${mock.baseUrl}/probe`],
      );
      const payload = JSON.parse(
        CRYPTO.decrypt({
          ciphertext: row.rows[0].secret_enc,
          nonce: row.rows[0].nonce,
          keyId: row.rows[0].key_id,
        }),
      );
      payload.expiresAt = opts.expiresAt;
      const enc = CRYPTO.encrypt(JSON.stringify(payload));
      await query(
        pool,
        `UPDATE vault_credentials SET secret_enc = $3, nonce = $4, key_id = $5
          WHERE tenant_id = $1 AND vault_id = $2 AND key = $6`,
        [
          TENANT.tenantId,
          vaultId,
          enc.ciphertext,
          enc.nonce,
          enc.keyId,
          `${mock.baseUrl}/probe`,
        ],
      );
    }
    return { vaultId, key: `${mock.baseUrl}/probe` };
  }

  /** Read the decrypted mcp_oauth secret payload straight from the DB. */
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

  // --- refresh ---------------------------------------------------------------

  it.skipIf(!RUNTIME)("refreshes client_secret_basic → new token persisted", async () => {
    const { vaultId, key } = await setupOauthCred({ method: "client_secret_basic" });
    let seenAuth = "";
    let seenBody = "";
    const fetchImpl = mockTokenFetch((auth, body) => {
      seenAuth = auth;
      seenBody = body;
      return {
        status: 200,
        json: { access_token: "AT_NEW", expires_in: 3600, refresh_token: "RT_NEW" },
      };
    });
    const r = await refreshOAuthToken(
      { pool, tenantCtx: TENANT, crypto: CRYPTO, locator: { vaultId, key } },
      { fetchImpl, dnsResolver: PUBLIC_RESOLVER },
    );
    expect(r.accessToken).toBe("AT_NEW");
    // Basic auth header survives the SSRF-pinned transport (client_secret_basic
    // relies on it; see refresh.ts `allowAuthorizationHeader`).
    expect(seenAuth).toMatch(/^Basic /);
    expect(seenBody).not.toContain("client_secret"); // not in the body
    const payload = await readPayload(vaultId, key);
    expect(payload.accessToken).toBe("AT_NEW");
    expect(payload.refreshToken).toBe("RT_NEW"); // rotated refresh token persisted
    expect(payload.expiresAt).toBeTruthy();
  }, 60_000);

  it.skipIf(!RUNTIME)("refreshes client_secret_post → creds in body", async () => {
    const { vaultId, key } = await setupOauthCred({ method: "client_secret_post" });
    let seenAuth = "";
    let seenBody = "";
    const fetchImpl = mockTokenFetch((auth, body) => {
      seenAuth = auth;
      seenBody = body;
      return { status: 200, json: { access_token: "AT_POST", expires_in: 600 } };
    });
    const r = await refreshOAuthToken(
      { pool, tenantCtx: TENANT, crypto: CRYPTO, locator: { vaultId, key } },
      { fetchImpl, dnsResolver: PUBLIC_RESOLVER },
    );
    expect(r.accessToken).toBe("AT_POST");
    expect(seenAuth).toBe(""); // no Basic header
    expect(seenBody).toContain("client_id=cid");
    expect(seenBody).toContain("client_secret=csec");
    const payload = await readPayload(vaultId, key);
    expect(payload.accessToken).toBe("AT_POST");
    // No new refresh_token returned → original retained.
    expect(payload.refreshToken).toBe("RT_OLD");
  }, 60_000);

  it.skipIf(!RUNTIME)(
    "refresh failure (invalid_grant 401) → vault_credential.refresh_failed event + invalid kind",
    async () => {
      const sink = new MemoryWebhookSink();
      const { vaultId, key } = await setupOauthCred({ method: "client_secret_basic" });
      const fetchImpl = mockTokenFetch(() => ({
        status: 401,
        json: { error: "invalid_grant" },
      }));
      await expect(
        refreshOAuthToken(
          { pool, tenantCtx: TENANT, crypto: CRYPTO, locator: { vaultId, key } },
          { webhookSink: sink, fetchImpl, dnsResolver: PUBLIC_RESOLVER },
        ),
      ).rejects.toThrow(/invalid_grant/);
      const failures = sink.events.filter((e) => e.type === "vault_credential.refresh_failed");
      expect(failures.length).toBe(1);
      expect(failures[0].id).toBeTruthy();
      // Thin payload — no secret material.
      expect(JSON.stringify(failures[0])).not.toContain("AT_OLD");
    },
  );

  it.skipIf(!RUNTIME)(
    "refresh failure (5xx) → refresh_failed event + transient kind",
    async () => {
      const sink = new MemoryWebhookSink();
      const { vaultId, key } = await setupOauthCred({ method: "client_secret_basic" });
      const fetchImpl = mockTokenFetch(() => ({
        status: 503,
        json: { error: "server_error" },
      }));
      try {
        await refreshOAuthToken(
          { pool, tenantCtx: TENANT, crypto: CRYPTO, locator: { vaultId, key } },
          { webhookSink: sink, fetchImpl, dnsResolver: PUBLIC_RESOLVER },
        );
      } catch (e) {
        expect((e as RefreshError).kind).toBe("transient");
      }
      expect(
        sink.events.filter((e) => e.type === "vault_credential.refresh_failed").length,
      ).toBe(1);
    },
  );

  // --- validate taxonomy -----------------------------------------------------

  it.skipIf(!RUNTIME)("validate: 2xx → valid", async () => {
    const { vaultId, key } = await setupOauthCred({ method: "client_secret_basic", accessToken: "AT_LIVE" });
    mock.probeHandler = (_req, res) => {
      res.statusCode = 200;
      res.end();
    };
    const status = await validateCredential(
      { pool, tenantCtx: TENANT, crypto: CRYPTO, vaultId, key },
      { fetchImpl: fetch as FetchImpl },
    );
    expect(status).toBe("valid");
  });

  it.skipIf(!RUNTIME)("validate: 401 → invalid (grant gone)", async () => {
    const { vaultId, key } = await setupOauthCred({ method: "client_secret_basic" });
    mock.probeHandler = (req, res) => {
      // Only 401 when the bearer is the live token; bare probes get 200.
      if (req.headers["authorization"] === "Bearer AT_OLD") {
        res.statusCode = 401;
      } else {
        res.statusCode = 200;
      }
      res.end();
    };
    const status = await validateCredential(
      { pool, tenantCtx: TENANT, crypto: CRYPTO, vaultId, key },
      { fetchImpl: fetch as FetchImpl },
    );
    expect(status).toBe("invalid");
  });

  it.skipIf(!RUNTIME)("validate: 5xx → unknown (transient)", async () => {
    const { vaultId, key } = await setupOauthCred({ method: "client_secret_basic" });
    mock.probeHandler = (_req, res) => {
      res.statusCode = 503;
      res.end();
    };
    const status = await validateCredential(
      { pool, tenantCtx: TENANT, crypto: CRYPTO, vaultId, key },
      { fetchImpl: fetch as FetchImpl },
    );
    expect(status).toBe("unknown");
  });

  it.skipIf(!RUNTIME)("validate: 429 → unknown", async () => {
    const { vaultId, key } = await setupOauthCred({ method: "client_secret_basic" });
    mock.probeHandler = (_req, res) => {
      res.statusCode = 429;
      res.end();
    };
    const status = await validateCredential(
      { pool, tenantCtx: TENANT, crypto: CRYPTO, vaultId, key },
      { fetchImpl: fetch as FetchImpl },
    );
    expect(status).toBe("unknown");
  });

  it.skipIf(!RUNTIME)("validate: network error → unknown", async () => {
    const { vaultId, key } = await setupOauthCred({ method: "client_secret_basic" });
    // A fetch that always throws (simulates DNS/timeout).
    const broken: FetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as FetchImpl;
    const status = await validateCredential(
      { pool, tenantCtx: TENANT, crypto: CRYPTO, vaultId, key },
      { fetchImpl: broken },
    );
    expect(status).toBe("unknown");
  });

  // --- re-resolution: rotation/archival propagation --------------------------

  it.skipIf(!RUNTIME)(
    "re-resolution: archiving a credential mid-session drops its binding (no restart)",
    async () => {
      const revalVault = await createVault(pool, TENANT, {
        name: `reval-${Math.random().toString(36).slice(2)}`,
        metadata: undefined,
      });
      const vaultId = revalVault.id;
      await addCredential(pool, TENANT, CRYPTO, vaultId, {
        key: "https://mcp.reval.example.com",
        category: "static_bearer",
        token: "tok_before_rotation",
      });
      const ctx = { tenantId: TENANT.tenantId, sessionId: "sess_reval", vaultIds: [vaultId] };
      const store = createVaultSecretStore(pool, { crypto: CRYPTO });
      const before = await store.resolveBindingsForSession(ctx);
      expect(before.some((b) => b.mcpServerUrl === "https://mcp.reval.example.com")).toBe(true);

      // Rotate: archive the credential mid-session (no session restart).
      await query(
        pool,
        `UPDATE vault_credentials SET status = 'archived', secret_enc = NULL,
                key_id = NULL, nonce = NULL, updated_at = now()
          WHERE tenant_id = $1 AND vault_id = $2 AND key = $3`,
        [TENANT.tenantId, vaultId, "https://mcp.reval.example.com"],
      );
      await store.revalidate(ctx); // no-op for static_bearer, but exercise the path

      const after = await store.resolveBindingsForSession(ctx);
      expect(after.some((b) => b.mcpServerUrl === "https://mcp.reval.example.com")).toBe(false);
    },
  );

  it.skipIf(!RUNTIME)(
    "re-resolution: expired mcp_oauth is refreshed in place (new token in DB)",
    async () => {
      // `createVaultSecretStore.revalidate` calls `refreshOAuthToken` internally
      // but exposes no SSRF/DNS/fetch seam, so the loop cannot reach a mock token
      // endpoint through the pinned transport (SEC-3). Exercise the same
      // refresh-in-place effect directly — the store's expiry-detection wiring is
      // covered by secret-store's own tests.
      const sink = new MemoryWebhookSink();
      const { vaultId, key } = await setupOauthCred({
        method: "client_secret_basic",
        expiresAt: new Date(Date.now() - 1000).toISOString(), // already expired
      });
      const fetchImpl = mockTokenFetch(() => ({
        status: 200,
        json: { access_token: "AT_REFRESHED_BY_LOOP", expires_in: 3600 },
      }));
      await refreshOAuthToken(
        { pool, tenantCtx: TENANT, crypto: CRYPTO, locator: { vaultId, key } },
        { webhookSink: sink, fetchImpl, dnsResolver: PUBLIC_RESOLVER, now: new Date() },
      );
      const payload = await readPayload(vaultId, key);
      expect(payload.accessToken).toBe("AT_REFRESHED_BY_LOOP");
      // No failure event on a successful refresh.
      expect(sink.events.length).toBe(0);
    },
  );

  // --- SSRF: tokenUrl resolving to an internal address is blocked (SEC-3) ------

  it.skipIf(!RUNTIME)(
    "refresh to a tokenUrl resolving to a private IP is blocked (invalid, not transient)",
    async () => {
      const sink = new MemoryWebhookSink();
      const { vaultId, key } = await setupOauthCred({ method: "client_secret_post" });
      // A resolver that maps the token host to cloud-metadata (would-be SSRF).
      const metadataResolver: PinnedDnsResolver = async () => [
        { address: "169.254.169.254", family: 4 },
      ];
      // The mock fetch must NEVER be reached — the guard rejects before any hop.
      let reached = false;
      const fetchImpl = mockTokenFetch(() => {
        reached = true;
        return { status: 200, json: { access_token: "LEAKED" } };
      });
      const err = await refreshOAuthToken(
        { pool, tenantCtx: TENANT, crypto: CRYPTO, locator: { vaultId, key } },
        { webhookSink: sink, fetchImpl, dnsResolver: metadataResolver },
      ).catch((e) => e as RefreshError);
      expect(reached).toBe(false);
      // Permanent config error → `invalid`, so the scheduler stops retrying it.
      expect((err as RefreshError).kind).toBe("invalid");
      // The stored token is untouched, and a failure event was emitted.
      const payload = await readPayload(vaultId, key);
      expect(payload.accessToken).toBe("AT_OLD");
      expect(
        sink.events.filter((e) => e.type === "vault_credential.refresh_failed").length,
      ).toBe(1);
    },
  );
});
