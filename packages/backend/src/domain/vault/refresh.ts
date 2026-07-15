/**
 * mcp_oauth token refresh (WP-2.4, §12.3, §12.5).
 *
 * Exchanges a stored refresh_token for a new access_token (RFC 6749 §6) against
 * the credential's `refresh` block. Auth methods supported (per the
 * `McpOAuthRefresh` contract): `client_secret_basic` (Basic auth header) and
 * `client_secret_post` (client_id/client_secret in the body). The `none` method
 * is mentioned by §12.3 but is NOT in the shared `McpOAuthRefresh` enum; it is
 * therefore not reachable today (see open questions) — the code below leaves a
 * seam so it can be added without touching this module once the contract grows.
 *
 * The mcp_oauth secret payload (the plaintext encrypted into `secret_enc`) is a
 * JSON blob — NOT a bare token — so refresh can carry the refresh_token and
 * client_secret alongside the access token without exposing them:
 *
 * ```json
 * { "accessToken": "...", "refreshToken": "...", "clientSecret": "...", "expiresAt": "..." }
 * ```
 *
 * SECURITY: plaintext is NEVER logged. Only the opaque credential ref is passed
 * to the `vault_credential.refresh_failed` webhook event (§23.2 — thin payload;
 * no secret material). The refresh_token/client_secret never leave this module
 * except as the encrypted `secret_enc` bytea and the outbound HTTPS request body
 * to `tokenUrl`.
 */

import { randomUUID } from "node:crypto";
import type { Pool, TenantCtx } from "../../infra/db/index.js";
import { tenantScopedQuery } from "../../infra/db/index.js";
import { tenantScopedClientQuery } from "../../infra/db/tenant-scoped.js";
import type { PoolClient } from "pg";
import type { VaultCrypto, EncryptedSecret } from "./crypto.js";
import type { WebhookSink } from "../ports.js";
import { safeFetchPinned, type PinnedDnsResolver } from "../net/ssrf-pin.js";

/** The OAuth refresh grant auth method (§12.3). */
export type RefreshAuthMethod = "client_secret_basic" | "client_secret_post";

/**
 * Non-sensitive refresh config stored in `vault_credentials.metadata`
 * (§3.5: `{refresh: {method, token_url, client_id}}`). The `clientSecret` is
 * NOT here — it lives only in the encrypted payload.
 */
export interface McpOAuthRefreshConfig {
  method: RefreshAuthMethod;
  tokenUrl: string;
  clientId: string;
}

/**
 * The structured mcp_oauth secret payload (encrypted into `secret_enc`).
 * Sensitive — NEVER returned by the API or logged.
 */
export interface McpOAuthSecretPayload {
  accessToken: string;
  refreshToken?: string;
  /** Present when `refresh.method !== "none"`. */
  clientSecret?: string;
  /** ISO 8601; when known (derived from `expires_in` on refresh). */
  expiresAt?: string;
}

/** The metadata shape persisted on the credential row. */
export interface McpOAuthMetadata {
  refresh?: McpOAuthRefreshConfig;
}

/** A successful token-refresh response (RFC 6749 §5.1). */
interface TokenSuccessResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

/** Injectable fetch — defaults to global `fetch` (Node ≥ 18). */
export type FetchImpl = typeof fetch;

/** Outcome of {@link refreshOAuthToken}. */
export interface RefreshResult {
  /** The new access token. */
  accessToken: string;
  /** The new expiry (ISO) if one was derivable. */
  expiresAt?: string;
  /** Whether a refresh token rotation occurred. */
  rotatedRefreshToken: boolean;
}

/** A credential locator (no secret material). */
export interface CredentialLocator {
  vaultId: string;
  key: string;
}

/**
 * Build the `Authorization` header value for a given refresh auth method.
 * Exported for tests; never logs the secret.
 */
export function authorizationHeader(
  method: RefreshAuthMethod,
  clientId: string,
  clientSecret: string | undefined,
): string | undefined {
  if (method === "client_secret_basic") {
    if (!clientSecret) return undefined;
    const raw = `${clientId}:${clientSecret}`;
    // encode to Latin-1 per RFC 6749 §2.3.1.
    const b64 = Buffer.from(raw, "latin1").toString("base64");
    return `Basic ${b64}`;
  }
  // client_secret_post → credentials go in the body, not the header.
  return undefined;
}

/** Build the URL-encoded refresh-grant body (RFC 6749 §6). */
export function buildRefreshBody(
  method: RefreshAuthMethod,
  refreshToken: string,
  clientId: string,
  clientSecret: string | undefined,
): string {
  const params = new URLSearchParams();
  params.set("grant_type", "refresh_token");
  params.set("refresh_token", refreshToken);
  if (method === "client_secret_post") {
    params.set("client_id", clientId);
    if (clientSecret) params.set("client_secret", clientSecret);
  }
  return params.toString();
}

/**
 * Parse a token endpoint response into a {@link RefreshResult}. Throws on an
 * OAuth error response (RFC 6749 §5.2) or a non-JSON body.
 */
export function parseTokenResponse(
  status: number,
  body: string,
  now: Date = new Date(),
): RefreshResult {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new RefreshError(
      status >= 500 || status === 429 ? "transient" : "invalid",
      `token endpoint returned non-JSON (status ${status})`,
    );
  }
  if (status < 200 || status >= 300) {
    const errCode =
      (json as { error?: string } | null)?.error ?? "http_error";
    // 5xx/429 are transient → retryable; 4xx (incl. invalid_grant) → invalid.
    const kind = status >= 500 || status === 429 ? "transient" : "invalid";
    throw new RefreshError(kind, `token endpoint error: ${errCode} (${status})`);
  }
  const tok = json as TokenSuccessResponse;
  if (!tok || typeof tok.access_token !== "string") {
    throw new RefreshError("invalid", "token response missing access_token");
  }
  const result: RefreshResult = {
    accessToken: tok.access_token,
    rotatedRefreshToken: typeof tok.refresh_token === "string",
  };
  if (typeof tok.expires_in === "number" && Number.isFinite(tok.expires_in)) {
    // Refresh slightly before true expiry (§12.5) — 30s skew window.
    const skewSeconds = 30;
    const expiresAt = new Date(now.getTime() + (tok.expires_in - skewSeconds) * 1000);
    result.expiresAt = expiresAt.toISOString();
  }
  return result;
}

/** Classification of a refresh failure (drives the validate taxonomy too). */
export type RefreshFailureKind = "invalid" | "transient";

/** A refresh failure carrying a machine-readable kind. */
export class RefreshError extends Error {
  constructor(
    public readonly kind: RefreshFailureKind,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "RefreshError";
  }
}

/** The row needed to refresh a credential (no secret material). */
type RefreshRow = {
  secretEnc: Buffer;
  nonce: Buffer;
  keyId: string;
  metadata: McpOAuthMetadata;
};

const LOAD_OAUTH_ROW_SQL = `SELECT secret_enc AS "secretEnc", nonce, key_id AS "keyId", metadata
       FROM vault_credentials
      WHERE tenant_id = $1 AND vault_id = $2 AND key = $3
        AND category = 'mcp_oauth' AND status = 'active'`;

/** Load the encrypted payload + metadata for an mcp_oauth credential. */
async function loadOAuthRow(
  pool: Pool,
  tenantCtx: TenantCtx,
  locator: CredentialLocator,
): Promise<RefreshRow | null> {
  const { rows } = await tenantScopedQuery<RefreshRow>(
    pool,
    tenantCtx,
    LOAD_OAUTH_ROW_SQL,
    [tenantCtx.tenantId, locator.vaultId, locator.key],
  );
  return rows[0] ?? null;
}

/** Load the row on an open transaction's client (under the advisory lock). */
async function loadOAuthRowOnClient(
  client: PoolClient,
  tenantCtx: TenantCtx,
  locator: CredentialLocator,
): Promise<RefreshRow | null> {
  const { rows } = await tenantScopedClientQuery<RefreshRow>(
    client,
    tenantCtx,
    LOAD_OAUTH_ROW_SQL,
    [tenantCtx.tenantId, locator.vaultId, locator.key],
  );
  return rows[0] ?? null;
}

/**
 * Persist a refreshed mcp_oauth secret payload (re-encrypted) on the open
 * transaction's client, so the write is committed atomically with the advisory
 * lock release (a second node blocked on the lock re-loads the fresh row).
 */
async function persistRefreshedSecret(
  client: PoolClient,
  tenantCtx: TenantCtx,
  locator: CredentialLocator,
  crypto: VaultCrypto,
  payload: McpOAuthSecretPayload,
): Promise<void> {
  const enc: EncryptedSecret = crypto.encrypt(JSON.stringify(payload));
  await tenantScopedClientQuery(
    client,
    tenantCtx,
    `UPDATE vault_credentials
        SET secret_enc = $3, key_id = $4, nonce = $5, updated_at = now()
      WHERE tenant_id = $1 AND vault_id = $2 AND key = $6
        AND category = 'mcp_oauth' AND status = 'active'`,
    [
      tenantCtx.tenantId,
      locator.vaultId,
      enc.ciphertext,
      enc.keyId,
      enc.nonce,
      locator.key,
    ],
  );
}

/**
 * Emit a `vault_credential.refresh_failed` webhook event (§12.5, §23.2). The
 * payload is thin — `type`/`id`/`createdAt` only, NO secret material. Failure
 * to dispatch is swallowed (refresh callers already know the refresh failed).
 */
async function emitRefreshFailed(
  webhookSink: WebhookSink | undefined,
  now: Date,
): Promise<void> {
  if (!webhookSink) return;
  try {
    await webhookSink.dispatch({
      type: "vault_credential.refresh_failed",
      id: randomUUID(),
      createdAt: now.toISOString(),
    });
  } catch {
    // Best-effort: the refresh failure is already surfaced to the caller.
  }
}

/**
 * Refresh an mcp_oauth credential's access token (§12.3, §12.5, R5.5).
 *
 * Loads the encrypted payload + refresh config from the DB, exchanges the
 * refresh_token at `tokenUrl` using the configured auth method, and persists
 * the new access/refresh token (re-encrypted). On any failure — invalid grant,
 * transient 5xx/429, or network error — emits `vault_credential.refresh_failed`
 * and throws {@link RefreshError}.
 *
 * **SSRF (SEC-3).** `tokenUrl` is tenant-controlled and this runs unattended, so
 * the token POST goes through the shared SSRF-pinned transport
 * ({@link safeFetchPinned}): the resolved IP is asserted public and the
 * connection is pinned to it (rebind-proof), while the original hostname is kept
 * for TLS SNI + certificate validation. A blocked target (private IP, non-https
 * scheme, disallowed port) fails as `invalid` so the loop stops retrying it. The
 * contract (`McpOAuthRefresh.tokenUrl`) additionally requires an `https` URL at
 * credential create-time, closing the scheme surface before persistence.
 *
 * **Cross-node coordination (R5.5).** Two nodes can decide the same credential
 * is expired and refresh it concurrently; the second refresh would spend a
 * refresh_token the first already rotated away (RFC 6749 §6), bricking the
 * credential with `invalid_grant`. To serialize refresh per credential across
 * nodes WITHOUT a schema change, the load → POST → persist runs inside a single
 * transaction on a dedicated client, gated by a Postgres transaction-scoped
 * advisory lock keyed on `vaultId:key`. A second node blocks on the lock until
 * the first commits, then RE-LOADS the (possibly rotated) row: if the grant is
 * now fresh (unexpired access token, or the refresh_token was rotated out from
 * under it) it returns that fresh token instead of re-refreshing with a stale
 * refresh_token. A `lock_timeout`/`statement_timeout` bounds the wait so a stuck
 * peer cannot hang the pool.
 *
 * @param deps pool, tenantCtx, crypto, locator (vaultId+key).
 * @param opts webhookSink (for failure events), fetchImpl/now (for tests), and
 *   lock/statement timeouts (ms) bounding the cross-node lock wait.
 */
export async function refreshOAuthToken(
  deps: {
    pool: Pool;
    tenantCtx: TenantCtx;
    crypto: VaultCrypto;
    locator: CredentialLocator;
  },
  opts: {
    webhookSink?: WebhookSink;
    /**
     * Injectable fetch for the token POST. When set, {@link safeFetchPinned}
     * bypasses its pinned Node transport and calls this impl instead — but the
     * scheme/port checks and public-IP assertion still run first. Tests only;
     * production uses the pinned transport.
     */
    fetchImpl?: FetchImpl;
    /**
     * Injectable DNS resolver for the SSRF public-IP assertion + IP pinning of
     * the token POST (tests reach a mock endpoint via a public-looking address).
     * Production uses the system resolver.
     */
    dnsResolver?: PinnedDnsResolver;
    now?: Date;
    /** Max ms to block waiting for a peer node's refresh to commit. */
    lockTimeoutMs?: number;
    /** Max ms for any single statement in the refresh transaction. */
    statementTimeoutMs?: number;
  } = {},
): Promise<RefreshResult> {
  const { pool, tenantCtx, crypto, locator } = deps;
  const now = opts.now ?? new Date();
  const lockTimeoutMs = Math.floor(opts.lockTimeoutMs ?? 10_000);
  const statementTimeoutMs = Math.floor(opts.statementTimeoutMs ?? 15_000);

  // Pre-lock read: fail fast on missing/undecryptable credentials (no lock
  // needed) and capture the refresh_token we intend to spend, so that after the
  // lock we can tell whether a peer already rotated it out from under us.
  const preRow = await loadOAuthRow(pool, tenantCtx, locator);
  if (!preRow) {
    // Credential archived/rotated away between scheduling and refresh.
    await emitRefreshFailed(opts.webhookSink, now);
    throw new RefreshError("invalid", `mcp_oauth credential not found: ${locator.key}`);
  }
  if (!preRow.metadata?.refresh) {
    await emitRefreshFailed(opts.webhookSink, now);
    throw new RefreshError("invalid", `no refresh block on credential: ${locator.key}`);
  }
  let intendedRefreshToken: string | undefined;
  try {
    intendedRefreshToken = (
      JSON.parse(
        crypto.decrypt({
          ciphertext: preRow.secretEnc,
          nonce: preRow.nonce,
          keyId: preRow.keyId,
        }),
      ) as McpOAuthSecretPayload
    ).refreshToken;
  } catch (e) {
    await emitRefreshFailed(opts.webhookSink, now);
    throw new RefreshError("invalid", "failed to decrypt mcp_oauth secret", e);
  }
  if (!intendedRefreshToken) {
    await emitRefreshFailed(opts.webhookSink, now);
    throw new RefreshError(
      "invalid",
      `mcp_oauth credential has no refresh_token: ${locator.key}`,
    );
  }

  // Serialize refresh per credential across nodes (R5.5). pg_advisory_xact_lock
  // blocks a concurrent node until our transaction commits.
  const lockKey = `${locator.vaultId}:${locator.key}`;
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL lock_timeout = ${lockTimeoutMs}`);
    await client.query(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [lockKey]);

    // Re-load under the lock: a peer may have just refreshed/rotated the row.
    const row = await loadOAuthRowOnClient(client, tenantCtx, locator);
    if (!row) {
      await emitRefreshFailed(opts.webhookSink, now);
      throw new RefreshError("invalid", `mcp_oauth credential not found: ${locator.key}`);
    }
    const cfg = row.metadata?.refresh;
    if (!cfg) {
      await emitRefreshFailed(opts.webhookSink, now);
      throw new RefreshError("invalid", `no refresh block on credential: ${locator.key}`);
    }
    let payload: McpOAuthSecretPayload;
    try {
      payload = JSON.parse(
        crypto.decrypt({
          ciphertext: row.secretEnc,
          nonce: row.nonce,
          keyId: row.keyId,
        }),
      ) as McpOAuthSecretPayload;
    } catch (e) {
      await emitRefreshFailed(opts.webhookSink, now);
      throw new RefreshError("invalid", "failed to decrypt mcp_oauth secret", e);
    }
    if (!payload.refreshToken) {
      await emitRefreshFailed(opts.webhookSink, now);
      throw new RefreshError(
        "invalid",
        `mcp_oauth credential has no refresh_token: ${locator.key}`,
      );
    }

    // A peer already won the refresh while we blocked on the lock: either the
    // access token is now unexpired, or the refresh_token was rotated out from
    // under us. Reuse the fresh grant rather than spending a stale refresh
    // token (which the token endpoint would reject with invalid_grant).
    const expiresMs = payload.expiresAt ? Date.parse(payload.expiresAt) : NaN;
    const stillFresh = Number.isFinite(expiresMs) && expiresMs > now.getTime();
    const rotatedByPeer = payload.refreshToken !== intendedRefreshToken;
    if (stillFresh || rotatedByPeer) {
      await client.query("COMMIT");
      committed = true;
      return {
        accessToken: payload.accessToken,
        expiresAt: payload.expiresAt,
        rotatedRefreshToken: false,
      };
    }

    // We hold the lock and the grant is still stale — perform the net refresh.
    const authHeader = authorizationHeader(cfg.method, cfg.clientId, payload.clientSecret);
    const body = buildRefreshBody(
      cfg.method,
      payload.refreshToken,
      cfg.clientId,
      payload.clientSecret,
    );

    // SEC-3: `tokenUrl` is tenant-controlled and the unattended refresh loop
    // POSTs to it every ~60s once a token expires — a raw `fetch` here lets a
    // tenant aim attacker-shaped OAuth bodies at internal endpoints. Route the
    // POST through the shared SSRF-pinned transport: it asserts the resolved IP
    // is public and pins the connection to that IP (rebind-proof) while keeping
    // the original hostname for TLS SNI + certificate validation. `client_secret_basic`
    // relies on the `Authorization: Basic` header reaching the endpoint, so we
    // opt out of the transport's default authorization-stripping — the header
    // carries the tenant's OWN client credentials, destined for their OWN
    // (now validated + pinned) token endpoint.
    let res: Response;
    try {
      const { response } = await safeFetchPinned(
        cfg.tokenUrl,
        {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            ...(authHeader ? { authorization: authHeader } : {}),
          },
          body,
          // Do not follow redirects (§23.5 rule; OAuth token endpoints won't 3xx).
          redirect: "manual",
        },
        opts.dnsResolver,
        {
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
          // Preserve the Basic auth header for client_secret_basic (see above).
          // Kept on hop 0 only — safeFetchPinned strips it across any redirect.
          preserveRequestAuth: true,
          // A blocked/invalid target (private IP, non-https, bad port) is a
          // permanent config error — surface it as `invalid` so the scheduler
          // does NOT retry an internal URL every 60s. A resolution miss may be
          // transient. Network/timeout errors are thrown raw (not via this
          // factory) and fall through to the transient branch below.
          errorFactory: (message, reason) =>
            new RefreshError(
              reason === "no-dns-records" ? "transient" : "invalid",
              `token endpoint refused by egress guard (${reason}): ${message}`,
            ),
        },
      );
      res = response;
    } catch (e) {
      await emitRefreshFailed(opts.webhookSink, now);
      // SSRF/scheme/port rejection already carries its RefreshError kind.
      if (e instanceof RefreshError) throw e;
      // Network/DNS/timeout failure → transient (retry).
      throw new RefreshError(
        "transient",
        `token endpoint unreachable: ${(e as Error).message}`,
        e,
      );
    }

    const text = await res.text();
    let result: RefreshResult;
    try {
      result = parseTokenResponse(res.status, text, now);
    } catch (e) {
      await emitRefreshFailed(opts.webhookSink, now);
      throw e instanceof RefreshError
        ? e
        : new RefreshError("transient", "failed to parse token response", e);
    }

    // Persist the refreshed payload. RFC 6749 §6: a new refresh_token MAY be
    // returned (rotation); keep the old one if the server didn't rotate.
    const nextPayload: McpOAuthSecretPayload = {
      accessToken: result.accessToken,
      refreshToken: result.rotatedRefreshToken
        ? (JSON.parse(text) as TokenSuccessResponse).refresh_token
        : payload.refreshToken,
      clientSecret: payload.clientSecret,
      expiresAt: result.expiresAt ?? payload.expiresAt,
    };
    await persistRefreshedSecret(client, tenantCtx, locator, crypto, nextPayload);
    await client.query("COMMIT");
    committed = true;
    return result;
  } finally {
    // On any throw (or the fresh-reuse early return already committed), make
    // sure the transaction is closed and the advisory lock released.
    if (!committed) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Connection already aborted/broken — nothing more to release.
      }
    }
    client.release();
  }
}
