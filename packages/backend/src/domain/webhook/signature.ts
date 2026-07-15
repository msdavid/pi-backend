/**
 * Webhook signature (WP-2.5, §23.4).
 *
 * Every delivery carries `X-Webhook-Signature: t=<unix-ms>,v1=<hex-hmac>`. The
 * HMAC-SHA256 is computed over `${t}.${rawBody}` with the webhook's `whsec_`
 * signing secret (the same secret the recipient received once at registration).
 *
 * Verification rejects signatures whose `t` is older than `maxAgeMs` (default
 * 5 minutes, §23.4) to bound replay windows. `verify` is constant-time on the
 * HMAC comparison (`crypto.timingSafeEqual`).
 *
 * No external dependency — Node `crypto` only (§4 "no new deps").
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Default replay-tolerance window: 5 minutes (§23.4). */
export const DEFAULT_SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;

/** Build the `X-Webhook-Signature` header value for `rawBody` under `secret`. */
export function sign(rawBody: string, secret: string, now: Date = new Date()): string {
  const t = now.getTime().toString();
  const mac = hmac(t, rawBody, secret);
  return `t=${t},v1=${mac}`;
}

/** Outcome of {@link verify}. */
export interface VerifyResult {
  ok: boolean;
  /** Machine-readable reason when `ok` is false. */
  reason?: string;
}

/**
 * Verify an `X-Webhook-Signature` header against `rawBody` + `secret`.
 * Rejects malformed headers, bad MACs, and timestamps outside `maxAgeMs`.
 */
export function verify(
  rawBody: string,
  signature: string,
  secret: string,
  maxAgeMs: number = DEFAULT_SIGNATURE_MAX_AGE_MS,
  now: Date = new Date(),
): VerifyResult {
  const parsed = parseSignature(signature);
  if (!parsed) {
    return { ok: false, reason: "malformed-signature" };
  }
  const age = now.getTime() - parsed.t;
  if (Math.abs(age) > maxAgeMs) {
    return { ok: false, reason: "timestamp-out-of-tolerance" };
  }
  const expected = hmac(parsed.t.toString(), rawBody, secret);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(parsed.v1, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad-mac" };
  }
  return { ok: true };
}

/** Compute the HMAC-SHA256 hex digest of `${t}.${rawBody}` under `secret`. */
function hmac(t: string, rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
}

interface ParsedSignature {
  t: number;
  v1: string;
}

/** Parse `t=<ts>,v1=<hex>` → components, or `null` if malformed. */
function parseSignature(signature: string): ParsedSignature | null {
  const parts = signature.split(",");
  let t: number | undefined;
  let v1: string | undefined;
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) return null;
    const k = p.slice(0, eq).trim();
    const v = p.slice(eq + 1).trim();
    if (k === "t") {
      const n = Number(v);
      if (!Number.isFinite(n)) return null;
      t = n;
    } else if (k === "v1") {
      v1 = v;
    }
  }
  if (t == null || v1 == null) return null;
  return { t, v1 };
}
