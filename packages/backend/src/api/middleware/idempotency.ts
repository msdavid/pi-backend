/**
 * `Idempotency-Key` replay protection middleware (WP-P0.5).
 *
 * Implements api-reference.md §"`Idempotency-Key`":
 * - Mutating `POST`s carrying an `Idempotency-Key` header have their response
 *   persisted (status + body) keyed by `(tenant_id, key_hash)`.
 * - A replay of the same key with the same request body returns the stored
 *   response byte-for-byte.
 * - A replay with a different request body yields `409 idempotency_conflict`.
 * - Stored responses are retained for 24h; the key may be reused after expiry.
 * - Scope is per-tenant: a key is unique only within the tenant that issued it.
 *
 * The middleware is a Fastify plugin registering a `preHandler` (replay check)
 * and an `onSend` hook (response capture). It no-ops gracefully when the
 * request carries no tenant context (P0.4's auth middleware attaches
 * `request.tenantCtx`); without a tenant, idempotency cannot be scoped.
 *
 * Concurrency (R5.1): the `preHandler` is **claim-first**. Instead of a plain
 * `SELECT` (which lets two simultaneous requests both miss and both run the
 * mutation), it atomically `INSERT … ON CONFLICT DO NOTHING RETURNING`s a
 * placeholder row with `response_status = 0`. Exactly one concurrent request
 * wins the claim and proceeds to the handler; the losers `SELECT` the existing
 * row and either replay it (finished), `409` on a body/no-store conflict, or —
 * when the winner is still running (`response_status = 0`) — `409` "request in
 * progress". The `onSend` hook overwrites the claimed row with the real
 * response via `storeResponse`'s `ON CONFLICT DO UPDATE`.
 *
 * Crash recovery (ROB-12): the claim carries a `claimed_at` lease. If the
 * winner crashes/OOMs between the claim and `onSend` (or its `storeResponse`
 * silently fails after a 2xx), the placeholder is left at `response_status = 0`
 * and would otherwise 409 every retry for the full 24h TTL. A retry that finds
 * a claim older than the lease atomically takes it over (`reclaimStale`) and
 * runs the handler, so a crashed request never permanently locks the key.
 *
 * Storage: the `idempotency_keys` table (migration 021) via the shared DB pool.
 * The response body is JSON text; all API responses are JSON, so replay sets
 * `Content-Type: application/json`. Hashing uses Node `crypto` sha256 (the key
 * is a client-generated opaque string, not a secret — sha256 is sufficient and
 * cheaper than argon2id; §8 reserves argon2id for credentials).
 *
 * Credential-issuing routes (`POST /v1/api-keys`, `POST /v1/webhooks`) opt out
 * of body capture with `config: { idempotencyNoStore: true }` (§25.1, §8): their
 * responses carry a raw `pmb_live_` key / `whsec_` signing secret that is shown
 * once and must never be persisted. The key, request-body hash and status are
 * still recorded (dedup + conflict detection stay intact, and the mutation is
 * not silently repeated), but the body is stored as `NULL` — so a replay cannot
 * re-serve the secret and yields `409 idempotency_conflict` instead, directing
 * the caller to list-and-revoke.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import type { ErrorEnvelope } from "@pi-managed/contracts";
import { query, tenantScopedQuery, type Pool, type TenantCtx } from "../../infra/db/index.js";

/** 24-hour retention window for stored responses (§"`Idempotency-Key`"). */
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/**
 * Sentinel `response_status` for a *claimed but in-flight* row (R5.1). The
 * claim-first INSERT writes `0`; the `onSend` hook overwrites it with the real
 * status once the handler completes. A concurrent replay that finds `0` knows
 * the original request is still running and returns `409` rather than executing
 * the mutation a second time.
 */
const STATUS_CLAIMED = 0;

/**
 * Claim lease (ROB-12). A placeholder row (`response_status = 0`) whose
 * `claimed_at` is older than this is treated as abandoned — the original
 * handler crashed/OOM'd (or its `storeResponse` silently failed) between the
 * claim and `onSend`, and without a lease the row would 409 every retry for the
 * full 24h TTL. The lease is deliberately far longer than any real API handler
 * so a genuinely in-flight request is never mistaken for a crashed one and its
 * claim stolen (which would double-execute the mutation).
 */
const CLAIM_LEASE_SECONDS = 5 * 60;

/** Reaper sweep interval: purge expired rows hourly (R5.1). */
const REAPER_INTERVAL_MS = 60 * 60 * 1000;

/** Per-request marker stash key (internal). */
const MARKER = Symbol.for("pi.idempotency.marker");

interface IdemMarker {
  tenantCtx: TenantCtx;
  keyHash: string;
  bodyHash: string;
  /** Route opted out of body capture (credential-issuing route). */
  noStore: boolean;
}

interface IdemRow {
  request_body_hash: string;
  response_status: number;
  response_body: string | null;
  expires_at: Date;
}

/**
 * Augment FastifyRequest with the optional tenant context attached by P0.4's
 * auth middleware. Declared here (and merged with P0.4's identical declaration)
 * so this module compiles independently. Absent → middleware no-ops.
 *
 * `idempotencyNoStore` is the route-level opt-out from response-body capture,
 * set via `config: { idempotencyNoStore: true }` on credential-issuing routes.
 */
declare module "fastify" {
  interface FastifyRequest {
    tenantCtx?: TenantCtx;
  }
  interface FastifyContextConfig {
    idempotencyNoStore?: boolean;
  }
}

/** sha256 hex digest of a string. */
function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Stable hash of the request body. Trivial whitespace differences are ignored
 * (§"`Idempotency-Key`"): an object body is serialized with sorted keys and no
 * extraneous whitespace; a string/Buffer body is hashed as its UTF-8 text.
 */
function hashBody(body: unknown): string {
  if (body == null) return sha256("");
  if (typeof body === "string") return sha256(body);
  if (Buffer.isBuffer(body)) return sha256(body.toString("utf8"));
  return sha256(stableStringify(body));
}

/** Deterministic JSON serialization: sorted object keys, no incidental whitespace. */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k]);
    return out;
  }
  return value;
}

/** Look up a stored response by (tenant_id, key_hash), unexpired only. */
async function findStored(
  pool: Pool,
  tenantCtx: TenantCtx,
  keyHash: string,
): Promise<IdemRow | null> {
  const { rows } = await tenantScopedQuery<IdemRow>(
    pool,
    tenantCtx,
    `SELECT request_body_hash, response_status, response_body, expires_at
       FROM idempotency_keys
      WHERE tenant_id = $1 AND key_hash = $2 AND expires_at > now()
      LIMIT 1`,
    [tenantCtx.tenantId, keyHash],
  );
  return rows[0] ?? null;
}

/**
 * Atomically claim `(tenant_id, key_hash)` for this request (R5.1). Inserts a
 * placeholder row (`response_status = 0`, `response_body = NULL`); `ON CONFLICT
 * DO NOTHING RETURNING` yields the row only when the insert actually happened.
 * A non-empty result means *this* request won the claim and should run the
 * handler; an empty result means a row already exists (a replay or an in-flight
 * peer) and the caller must fall through to {@link findStored}.
 */
async function claimKey(
  pool: Pool,
  tenantCtx: TenantCtx,
  keyHash: string,
  bodyHash: string,
): Promise<boolean> {
  const { rows } = await tenantScopedQuery<{ key_hash: string }>(
    pool,
    tenantCtx,
    `INSERT INTO idempotency_keys
       (tenant_id, key_hash, request_body_hash, response_status, response_body, claimed_at, expires_at)
     VALUES ($1, $2, $3, ${STATUS_CLAIMED}, NULL, now(),
             now() + interval '${IDEMPOTENCY_TTL_SECONDS} seconds')
     ON CONFLICT (tenant_id, key_hash) DO NOTHING
     RETURNING key_hash`,
    [tenantCtx.tenantId, keyHash, bodyHash],
  );
  return rows.length > 0;
}

/**
 * Take over a *stale* in-flight claim (ROB-12). When `claimKey` loses and the
 * existing row is still `response_status = 0` with a `claimed_at` older than
 * {@link CLAIM_LEASE_SECONDS}, the original holder crashed before `onSend`
 * released or overwrote it. This atomically re-stamps the placeholder for the
 * current request (mirrors the `job_runs` recovery CAS from migration 034): the
 * single-row `UPDATE … WHERE response_status = 0 AND claimed_at < <lease>
 * RETURNING` lets exactly one concurrent retry win the takeover; the rest match
 * no row and fall through to a `409` in-progress. A non-empty result means this
 * request now owns the claim and should run the handler.
 */
async function reclaimStale(
  pool: Pool,
  tenantCtx: TenantCtx,
  keyHash: string,
  bodyHash: string,
): Promise<boolean> {
  const { rows } = await tenantScopedQuery<{ key_hash: string }>(
    pool,
    tenantCtx,
    `UPDATE idempotency_keys
        SET request_body_hash = $3,
            claimed_at        = now(),
            created_at        = now(),
            expires_at        = now() + interval '${IDEMPOTENCY_TTL_SECONDS} seconds'
      WHERE tenant_id = $1 AND key_hash = $2
        AND response_status = ${STATUS_CLAIMED}
        AND claimed_at < now() - interval '${CLAIM_LEASE_SECONDS} seconds'
      RETURNING key_hash`,
    [tenantCtx.tenantId, keyHash, bodyHash],
  );
  return rows.length > 0;
}

/**
 * Release an in-flight claim after a non-success response (R5.1). The `onSend`
 * hook only persists 2xx responses; an error leaves the placeholder row with
 * `response_status = 0`, which would 409 every subsequent retry for 24h. Deleting
 * it (only while still in the claimed state) lets the caller retry the same key.
 */
async function releaseClaim(
  pool: Pool,
  tenantCtx: TenantCtx,
  keyHash: string,
): Promise<void> {
  await tenantScopedQuery(
    pool,
    tenantCtx,
    `DELETE FROM idempotency_keys
      WHERE tenant_id = $1 AND key_hash = $2 AND response_status = ${STATUS_CLAIMED}`,
    [tenantCtx.tenantId, keyHash],
  );
}

/**
 * Persist (or refresh) a stored response. ON CONFLICT refreshes an expired row.
 * `body` is `null` for a `idempotencyNoStore` route: the key is still recorded,
 * but the credential-bearing body is never written.
 */
async function storeResponse(
  pool: Pool,
  tenantCtx: TenantCtx,
  keyHash: string,
  bodyHash: string,
  status: number,
  body: string | null,
): Promise<void> {
  await tenantScopedQuery(
    pool,
    tenantCtx,
    `INSERT INTO idempotency_keys
       (tenant_id, key_hash, request_body_hash, response_status, response_body, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + interval '${IDEMPOTENCY_TTL_SECONDS} seconds')
     ON CONFLICT (tenant_id, key_hash) DO UPDATE
       SET request_body_hash = EXCLUDED.request_body_hash,
           response_status   = EXCLUDED.response_status,
           response_body     = EXCLUDED.response_body,
           created_at        = now(),
           expires_at        = EXCLUDED.expires_at`,
    [tenantCtx.tenantId, keyHash, bodyHash, status, body],
  );
}

/**
 * `409 idempotency_conflict` envelope for a request that collides with an
 * in-flight claim (R5.1). Same shape/code as the no-store 409, differing only
 * in message — the mutation is already running, so the caller should retry once
 * it settles rather than re-issue.
 */
function inProgressEnvelope(requestId: string): ErrorEnvelope {
  return {
    error: {
      type: "request_error",
      code: "idempotency_conflict",
      message:
        "A request with this Idempotency-Key is already in progress. Retry once it completes to obtain the stored response.",
      requestId,
    },
  };
}

/**
 * Install the idempotency hooks on `app`. Hooks are attached directly to the
 * instance (not via an encapsulated plugin) so they apply to every route: the
 * `preHandler` short-circuits replays, the `onSend` hook captures and persists
 * the first response.
 */
export function idempotencyMiddleware(app: FastifyInstance, pool: Pool): void {
  app.addHook(
    "preHandler",
    async (req: FastifyRequest, reply: FastifyReply) => {
        if (req.method !== "POST") return;
        const keyHeader = req.headers["idempotency-key"];
        if (!keyHeader || Array.isArray(keyHeader)) return;
        const tenantCtx = req.tenantCtx;
        if (!tenantCtx) return; // no tenant → cannot scope; no-op.

        const keyHash = sha256(keyHeader);
        const bodyHash = hashBody(req.body);
        const noStore = req.routeOptions.config?.idempotencyNoStore === true;

        // Claim-first (R5.1): atomically insert a placeholder row. Exactly one
        // of N concurrent identical requests wins; it runs the handler and
        // onSend overwrites the placeholder with the real response.
        const claimed = await claimKey(pool, tenantCtx, keyHash, bodyHash);
        if (claimed) {
          (req as unknown as Record<symbol, IdemMarker>)[MARKER] = {
            tenantCtx,
            keyHash,
            bodyHash,
            noStore,
          };
          return;
        }

        // Claim lost: a row already exists (a finished replay or an in-flight
        // peer). Read it and apply the replay / conflict / in-progress branches.
        const stored = await findStored(pool, tenantCtx, keyHash);
        if (!stored) {
          // The row vanished between the failed claim and the read (expired and
          // reaped, or released by a peer's error). Retry the claim once; if it
          // still loses, treat it as an in-flight conflict.
          const reclaimed = await claimKey(pool, tenantCtx, keyHash, bodyHash);
          if (reclaimed) {
            (req as unknown as Record<symbol, IdemMarker>)[MARKER] = {
              tenantCtx,
              keyHash,
              bodyHash,
              noStore,
            };
            return;
          }
          return reply.status(409).send(inProgressEnvelope(req.id));
        }
        if (stored.response_status === STATUS_CLAIMED) {
          // A peer holds the claim. If it is stale (older than the lease) the
          // holder crashed before onSend released/overwrote it — atomically
          // take it over so this retry runs, rather than 409ing for the full
          // 24h TTL (ROB-12). Only one concurrent retry wins the takeover.
          const reclaimed = await reclaimStale(pool, tenantCtx, keyHash, bodyHash);
          if (reclaimed) {
            (req as unknown as Record<symbol, IdemMarker>)[MARKER] = {
              tenantCtx,
              keyHash,
              bodyHash,
              noStore,
            };
            return;
          }
          // Still fresh → a peer is genuinely running: do NOT re-execute the
          // mutation. Same 409 shape as the no-store conflict (R5.1).
          return reply.status(409).send(inProgressEnvelope(req.id));
        }
        if (stored.response_body === null) {
          // Credential-issuing route: the body was deliberately not persisted,
          // so the secret cannot (and must not) be re-served. The mutation
          // already happened — tell the caller to list-and-revoke (§25.1, §8).
          const env: ErrorEnvelope = {
            error: {
              type: "request_error",
              code: "idempotency_conflict",
              message:
                "Idempotency-Key was already used to issue a credential; the secret is shown once and cannot be replayed. List the resource and revoke it if the original response was lost, then retry with a new Idempotency-Key.",
              requestId: req.id,
            },
          };
          return reply.status(409).send(env);
        }
        if (stored.request_body_hash !== bodyHash) {
          // Same key, different body → 409 idempotency_conflict (§"Idempotency-Key").
          const env: ErrorEnvelope = {
            error: {
              type: "request_error",
              code: "idempotency_conflict",
              message: "Idempotency-Key was reused with a different request body.",
              requestId: req.id,
            },
          };
          return reply.status(409).send(env);
        }
        // Replay: return the stored response byte-for-byte.
        reply
          .status(stored.response_status)
          .header("content-type", "application/json; charset=utf-8")
          .send(stored.response_body);
      },
    );

    app.addHook(
      "onSend",
      async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
        const marker = (req as unknown as Record<symbol, IdemMarker | undefined>)[MARKER];
        if (!marker) return payload;
        // Only persist successful responses; errors are not cached. Release the
        // claim (R5.1) so the placeholder row doesn't 409 every retry for 24h —
        // an error must leave the key reusable, not locked in-progress forever.
        if (reply.statusCode < 200 || reply.statusCode >= 300) {
          try {
            await releaseClaim(pool, marker.tenantCtx, marker.keyHash);
          } catch {
            // Best-effort: a lingering placeholder expires via the reaper.
          }
          return payload;
        }
        // Credential-issuing routes opt out of body capture: record the key
        // for dedup, but store NO body (§25.1, §8) — a replay then 409s rather
        // than re-serving a raw `pmb_live_` key / `whsec_` secret.
        const body = marker.noStore
          ? null
          : typeof payload === "string"
            ? payload
            : Buffer.isBuffer(payload)
              ? payload.toString("utf8")
              : JSON.stringify(payload);
        try {
          await storeResponse(
            pool,
            marker.tenantCtx,
            marker.keyHash,
            marker.bodyHash,
            reply.statusCode,
            body,
          );
        } catch {
          // Persistence failure must not break the in-flight response.
        }
        return payload;
      },
    );
  }

/**
 * Start a background reaper that periodically deletes expired idempotency rows
 * (R5.1). Without it the table grows forever — every claimed/stored key persists
 * a row, and only expiry (not any read path) removes it. Cross-tenant sweep, so
 * it uses the raw {@link query} helper rather than the tenant-scoped wrapper.
 *
 * The `setInterval` is `unref()`'d so it never keeps the process alive on its
 * own. Returns a `stop` function that clears the timer (call it on shutdown).
 */
export function startIdempotencyReaper(
  pool: Pool,
  intervalMs: number = REAPER_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    void query(pool, `DELETE FROM idempotency_keys WHERE expires_at <= now()`).catch(
      () => {
        // Best-effort: a failed sweep retries on the next tick.
      },
    );
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
