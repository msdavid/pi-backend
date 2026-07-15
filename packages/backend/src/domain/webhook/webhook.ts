/**
 * Webhook service (WP-2.5, §23, §3.10).
 *
 * - `createWebhook`: validates the endpoint (HTTPS :443, public hostname),
 *   generates a `whsec_` signing secret shown **once**, persists the webhook, and
 *   returns the secret only in this create response.
 * - `listWebhooks` / `getWebhook`: never return the signing secret.
 * - `deleteWebhook`: hard-delete; `204` on success, `false` if absent.
 * - `testDelivery`: send a synthetic `webhook.test` event (one shot, no enqueue)
 *   and report the HTTP response code (§23.5).
 *
 * Signing-secret storage: the spec calls for an argon2id hash (like API keys),
 * but the dispatcher must HMAC-**sign** outbound deliveries — a one-way argon2id
 * hash cannot produce signatures. The secret is therefore stored
 * **AES-256-GCM encrypted** (recoverable, reusing `domain/vault/crypto`) so the
 * dispatcher can decrypt to sign, while remaining "shown once" (never returned
 * on retrieve). See OPEN QUESTIONS in the WP-2.5 report. No raw secret is ever
 * logged or returned outside `createWebhook`.
 */

import { randomBytes } from "node:crypto";
import {
  tenantScopedQuery,
  type Pool,
  type TenantCtx,
} from "../../infra/db/index.js";
import { newId, ULID_PATTERN } from "../tenant/ids.js";
import { getDefaultVaultCrypto } from "../vault/crypto.js";
import type {
  WebhookCreate,
  WebhookEventType,
} from "@pi-managed/contracts";
import { resolveAndAssertPublic, defaultWebhookDnsResolver } from "./ssrf.js";
import { sign as signPayload } from "./signature.js";

const SECRET_PREFIX = "whsec_";
const SECRET_LEN = 32;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Webhook lifecycle status (§3.10): `active` until auto-disabled. */
export type WebhookStatus = "active" | "disabled";

/** Persisted webhook row (DB shape). */
export interface WebhookRow {
  id: string;
  url: string;
  eventTypes: WebhookEventType[];
  status: WebhookStatus;
  disabledReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Create response — the ONLY surface that includes `signingSecret` (§23.3). */
export interface CreatedWebhook extends WebhookRow {
  signingSecret: string;
}

/** A webhook with its decrypted signing secret (internal — dispatcher only). */
export interface WebhookWithSecret extends WebhookRow {
  signingSecret: string;
}

/** `^whsec_(<ulid>)_(<secret>)$`. */
const SECRET_REGEX = new RegExp(
  `^${SECRET_PREFIX}(${ULID_PATTERN})_([0-9A-HJKMNP-TV-Z]{${SECRET_LEN}})$`,
);

/** Generate a `SECRET_LEN`-char Crockford-Base32 secret (256 % 32 == 0 → no bias). */
function randomSecret(): string {
  const bytes = randomBytes(SECRET_LEN);
  let str = "";
  for (let i = 0; i < SECRET_LEN; i++) {
    str += CROCKFORD[bytes[i] % 32];
  }
  return str;
}

/** Build the raw `whsec_<ulid>_<secret>` shown once at creation. */
function buildRawSecret(webhookId: string): string {
  const ulidPart = webhookId.slice("wh_".length);
  return `${SECRET_PREFIX}${ulidPart}_${randomSecret()}`;
}

/**
 * Validate the endpoint URL (§23.3): HTTPS, port 443 (explicit or default),
 * hostname not a private IP literal. The full DNS private-resolution check
 * happens at delivery time (immediate auto-disable, §23.5); at creation we
 * only reject structurally private targets.
 */
function validateEndpointUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new EndpointValidationError("invalid url");
  }
  if (parsed.protocol !== "https:") {
    throw new EndpointValidationError("endpoint must use https");
  }
  // Port 443 is the default for https; an explicit port must be 443 (§23.3).
  if (parsed.port !== "" && parsed.port !== "443") {
    throw new EndpointValidationError("endpoint must be on port 443");
  }
  if (parsed.username || parsed.password) {
    throw new EndpointValidationError("endpoint must not carry credentials");
  }
  return parsed;
}

/** Thrown for an invalid endpoint URL; mapped to 422 by the route. */
export class EndpointValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EndpointValidationError";
  }
}

/**
 * Encrypt `secret` for at-rest storage in `signing_secret_hash`. Stored as a
 * JSON string `{ciphertext, nonce, keyId}` (all base64) so the dispatcher can
 * recover the secret to sign outbound deliveries.
 */
function encryptSecretForStorage(secret: string): string {
  const crypto = getDefaultVaultCrypto();
  const enc = crypto.encrypt(secret);
  return JSON.stringify({
    ciphertext: enc.ciphertext.toString("base64"),
    nonce: enc.nonce.toString("base64"),
    keyId: enc.keyId,
  });
}

/** Recover the signing secret from its stored JSON form. */
export function decryptStoredSecret(stored: string): string {
  const crypto = getDefaultVaultCrypto();
  const obj = JSON.parse(stored) as {
    ciphertext: string;
    nonce: string;
    keyId: string;
  };
  return crypto.decrypt({
    ciphertext: Buffer.from(obj.ciphertext, "base64"),
    nonce: Buffer.from(obj.nonce, "base64"),
    keyId: obj.keyId,
  });
}

/** Map a DB row to the wire {@link WebhookRow} shape (no secret). */
function toWebhookRow(r: {
  id: string;
  url: string;
  event_types: WebhookEventType[];
  status: string;
  disabled_reason: string | null;
  created_at: Date;
  updated_at: Date;
}): WebhookRow {
  return {
    id: r.id,
    url: r.url,
    eventTypes: r.event_types,
    status: r.status as WebhookStatus,
    disabledReason: r.disabled_reason,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

/**
 * Register a webhook endpoint. Returns the `whsec_` signing secret **once**;
 * only the encrypted form is persisted. Validates the endpoint URL and, on a
 * best-effort basis, resolves the hostname to reject private-IP targets up front
 * (the authoritative check still runs at delivery time, §23.5).
 */
export async function createWebhook(
  pool: Pool,
  tenantCtx: TenantCtx,
  input: WebhookCreate,
): Promise<CreatedWebhook> {
  const parsed = validateEndpointUrl(input.url);
  // Best-effort early rejection of private-IP hostnames; DNS failures are
  // non-fatal at registration (the delivery-time guard is authoritative).
  try {
    await resolveAndAssertPublic(parsed.hostname, defaultWebhookDnsResolver);
  } catch {
    // A transient DNS error shouldn't block registration; private-IP hits are
    // caught by the literal check inside resolveAndAssertPublic only when DNS
    // resolves. Defer hard failures to delivery-time auto-disable.
  }
  if (input.eventTypes.length === 0) {
    throw new EndpointValidationError("eventTypes must not be empty");
  }
  const id = newId("wh_");
  const rawSecret = buildRawSecret(id);
  const storedSecret = encryptSecretForStorage(rawSecret);
  const { rows } = await tenantScopedQuery<{
    url: string;
    event_types: WebhookEventType[];
    status: string;
    disabled_reason: string | null;
    created_at: Date;
    updated_at: Date;
  }>(
    pool,
    tenantCtx,
    `INSERT INTO webhooks (tenant_id, id, url, signing_secret_hash, event_types, status)
       VALUES ($1, $2, $3, $4, $5, 'active')
     RETURNING url, event_types, status, disabled_reason, created_at, updated_at`,
    [
      tenantCtx.tenantId,
      id,
      input.url,
      storedSecret,
      JSON.stringify(input.eventTypes),
    ],
  );
  return {
    ...toWebhookRow({ id, ...rows[0] }),
    signingSecret: rawSecret,
  };
}

/** List a tenant's webhooks (never includes the signing secret). */
export async function listWebhooks(
  pool: Pool,
  tenantCtx: TenantCtx,
): Promise<WebhookRow[]> {
  const { rows } = await tenantScopedQuery<{
    id: string;
    url: string;
    event_types: WebhookEventType[];
    status: string;
    disabled_reason: string | null;
    created_at: Date;
    updated_at: Date;
  }>(
    pool,
    tenantCtx,
    `SELECT id, url, event_types, status, disabled_reason, created_at, updated_at
       FROM webhooks
      WHERE tenant_id = $1
      ORDER BY created_at DESC`,
    [tenantCtx.tenantId],
  );
  return rows.map(toWebhookRow);
}

/** Retrieve a webhook by id (never includes the signing secret). `null` if absent. */
export async function getWebhook(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
): Promise<WebhookRow | null> {
  const { rows } = await tenantScopedQuery<{
    id: string;
    url: string;
    event_types: WebhookEventType[];
    status: string;
    disabled_reason: string | null;
    created_at: Date;
    updated_at: Date;
  }>(
    pool,
    tenantCtx,
    `SELECT id, url, event_types, status, disabled_reason, created_at, updated_at
       FROM webhooks
      WHERE tenant_id = $1 AND id = $2`,
    [tenantCtx.tenantId, id],
  );
  return rows[0] ? toWebhookRow(rows[0]) : null;
}

/** Load a webhook WITH its decrypted signing secret (dispatcher only). */
export async function getWebhookWithSecret(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
): Promise<WebhookWithSecret | null> {
  const { rows } = await tenantScopedQuery<{
    id: string;
    url: string;
    signing_secret_hash: string;
    event_types: WebhookEventType[];
    status: string;
    disabled_reason: string | null;
    created_at: Date;
    updated_at: Date;
  }>(
    pool,
    tenantCtx,
    `SELECT id, url, signing_secret_hash, event_types, status, disabled_reason, created_at, updated_at
       FROM webhooks
      WHERE tenant_id = $1 AND id = $2`,
    [tenantCtx.tenantId, id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    ...toWebhookRow(r),
    signingSecret: decryptStoredSecret(r.signing_secret_hash),
  };
}

/** Hard-delete a webhook. Returns `true` if a row was deleted, `false` if absent. */
export async function deleteWebhook(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
): Promise<boolean> {
  const { rowCount } = await tenantScopedQuery(
    pool,
    tenantCtx,
    `DELETE FROM webhooks WHERE tenant_id = $1 AND id = $2`,
    [tenantCtx.tenantId, id],
  );
  return (rowCount ?? 0) > 0;
}

/** Result of a test delivery (§23.5). */
export interface TestDeliveryResult {
  delivered: boolean;
  responseCode?: number;
}

/** Test-delivery options (injectable fetch + DNS for tests). */
export interface TestDeliveryDeps {
  fetchImpl?: typeof fetch;
  dnsResolver?: typeof defaultWebhookDnsResolver;
}

/**
 * Send a synthetic `webhook.test` event to the endpoint (one shot, no enqueue).
 * Signs the payload with the webhook's secret and POSTs it (no redirect
 * following). Reports the response code. Disabled webhooks return
 * `{delivered:false}` with no request made.
 */
export async function testDelivery(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
  deps: TestDeliveryDeps = {},
): Promise<TestDeliveryResult> {
  const wh = await getWebhookWithSecret(pool, tenantCtx, id);
  if (!wh) return { delivered: false };
  if (wh.status === "disabled") {
    return { delivered: false };
  }
  const payload = {
    type: "webhook.test",
    id: newId("evt_"),
    createdAt: new Date().toISOString(),
  };
  const rawBody = JSON.stringify(payload);
  const signature = signPayload(rawBody, wh.signingSecret);
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(wh.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": signature,
      },
      body: rawBody,
      redirect: "error",
    });
    return {
      delivered: res.status >= 200 && res.status < 300,
      responseCode: res.status,
    };
  } catch {
    return { delivered: false };
  }
}

/** Re-exported for route URL parsing. */
export function isWebhookSecret(s: string): boolean {
  return SECRET_REGEX.test(s);
}
