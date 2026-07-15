/**
 * Webhook signature unit tests (WP-2.5, §23.4).
 *
 * Covers: sign→verify round-trip, tampered body rejected, expired timestamp
 * rejected (>5 min tolerance), bad MAC rejected, malformed header rejected.
 */

import { describe, expect, it } from "vitest";
import { sign, verify, DEFAULT_SIGNATURE_MAX_AGE_MS } from "../signature.js";

const SECRET = "whsec_01JTESTTESTTESTTESTTESTES_0123456789ABCDEFGHJKMNPQRSTUVWX";
const BODY = JSON.stringify({
  type: "session.status_idle",
  id: "evt_01JTEST",
  createdAt: "2026-07-13T12:00:00Z",
});

describe("webhook signature", () => {
  it("verifies a freshly signed payload", () => {
    const now = new Date("2026-07-13T12:00:00Z");
    const sig = sign(BODY, SECRET, now);
    expect(verify(BODY, sig, SECRET, DEFAULT_SIGNATURE_MAX_AGE_MS, now)).toEqual({
      ok: true,
    });
  });

  it("rejects a tampered body (bad MAC)", () => {
    const now = new Date("2026-07-13T12:00:00Z");
    const sig = sign(BODY, SECRET, now);
    const tampered = BODY.replace("session.status_idle", "session.status_run_started");
    const res = verify(tampered, sig, SECRET, DEFAULT_SIGNATURE_MAX_AGE_MS, now);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("bad-mac");
  });

  it("rejects signatures older than the 5-minute tolerance", () => {
    const signedAt = new Date("2026-07-13T12:00:00Z");
    const now = new Date(signedAt.getTime() + DEFAULT_SIGNATURE_MAX_AGE_MS + 1);
    const sig = sign(BODY, SECRET, signedAt);
    const res = verify(BODY, sig, SECRET, DEFAULT_SIGNATURE_MAX_AGE_MS, now);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("timestamp-out-of-tolerance");
  });

  it("accepts a signature exactly at the tolerance boundary", () => {
    const signedAt = new Date("2026-07-13T12:00:00Z");
    const now = new Date(signedAt.getTime() + DEFAULT_SIGNATURE_MAX_AGE_MS);
    const sig = sign(BODY, SECRET, signedAt);
    expect(verify(BODY, sig, SECRET, DEFAULT_SIGNATURE_MAX_AGE_MS, now).ok).toBe(true);
  });

  it("rejects a wrong secret (bad MAC)", () => {
    const now = new Date("2026-07-13T12:00:00Z");
    const sig = sign(BODY, SECRET, now);
    const res = verify(BODY, sig, "whsec_0WRONGWRONGWRONGWRONGWRONGW_0123456789WRONGWRONGWRONGWRONG12", DEFAULT_SIGNATURE_MAX_AGE_MS, now);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("bad-mac");
  });

  it("rejects a malformed signature header", () => {
    const now = new Date("2026-07-13T12:00:00Z");
    expect(verify(BODY, "garbage", SECRET, DEFAULT_SIGNATURE_MAX_AGE_MS, now).ok).toBe(false);
    expect(verify(BODY, "t=notanumber,v1=deadbeef", SECRET, DEFAULT_SIGNATURE_MAX_AGE_MS, now).ok).toBe(false);
    expect(verify(BODY, "t=12345", SECRET, DEFAULT_SIGNATURE_MAX_AGE_MS, now).ok).toBe(false);
  });
});
