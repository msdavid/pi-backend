/**
 * Webhook billing sink unit tests (WP-5.3, §29.6).
 *
 * Coverage:
 * - posts the MeteringEvent JSON body to the configured https endpoint,
 *   signed with the X-Webhook-Signature scheme (verifiable round-trip).
 * - 2xx ack completes after one attempt.
 * - non-2xx is retried (at-least-once) then succeeds; the same X-Metering-Id is
 *   carried across retries (recipient dedup key).
 * - rejects a non-https endpoint at construction.
 * - W8.2: egress goes through the shared SSRF-pinned transport — an endpoint that
 *   resolves to a private IP (or uses a non-80/443 port) is never posted to, and the
 *   block is terminal (no retries) and never throws.
 *
 * `fetch` + the DNS resolver are injected so no real server / real DNS is needed.
 */

import type { LookupAddress } from "node:dns";
import { describe, expect, it } from "vitest";
import { verify as verifySignature } from "../../webhook/signature.js";
import {
  WebhookBillingSink,
  defaultBillingBackoff,
} from "../webhook-sink.js";
import type { MeteringEvent } from "../sink.js";

const SECRET = "whsec_01JTESTTESTTESTTESTTESTES_0123456789ABCDEFGHJKMNPQRSTUVWX";
const ENDPOINT = "https://billing.example.local/metering";

/** Resolver returning a public IP, so the SSRF assertion passes for the fake host. */
const PUBLIC_RESOLVER = async (): Promise<LookupAddress[]> => [
  { address: "8.8.8.8", family: 4 },
];
/** Resolver returning a link-local/private IP (the SSRF case). */
const PRIVATE_RESOLVER = async (): Promise<LookupAddress[]> => [
  { address: "169.254.169.254", family: 4 },
];

const EVENT: MeteringEvent = {
  tenantId: "tnt_01J",
  sessionId: "sess_01J",
  model: "claude-3-5-sonnet",
  inputTokens: 100,
  outputTokens: 50,
  usdCost: 0.0042,
  recordedAt: "2026-07-13T12:00:00.000Z",
};

/** Captured delivery request. */
interface CapturedReq {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** Build an injectable fetch that responds per `responses` in order. */
function makeFetch(responses: number[]): {
  fetchImpl: typeof fetch;
  calls: CapturedReq[];
} {
  const calls: CapturedReq[] = [];
  let i = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const h = new Headers(init?.headers);
    const headers: Record<string, string> = {};
    h.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    });
    const status = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response("ok", { status });
  };
  return { fetchImpl, calls };
}

describe("WebhookBillingSink", () => {
  it("posts the signed metering event body and acks on 2xx", async () => {
    const { fetchImpl, calls } = makeFetch([200]);
    const sink = new WebhookBillingSink({
      endpoint: ENDPOINT,
      signingSecret: SECRET,
      fetchImpl,
      dnsResolver: PUBLIC_RESOLVER,
    });

    await sink.recordMetering(EVENT);

    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.method).toBe("POST");
    expect(c.url).toBe(ENDPOINT);
    expect(c.headers["content-type"]).toBe("application/json");
    expect(c.headers["x-metering-id"]).toMatch(/^met_/);
    expect(JSON.parse(c.body)).toEqual(EVENT);

    // Signature verifies against the posted body + secret.
    const sig = c.headers["x-webhook-signature"];
    expect(typeof sig).toBe("string");
    expect(
      verifySignature(c.body, sig as string, SECRET, 5 * 60 * 1000, new Date()),
    ).toEqual({ ok: true });
  });

  it("retries on non-2xx then succeeds (at-least-once), same metering id", async () => {
    const { fetchImpl, calls } = makeFetch([500, 500, 200]);
    const sink = new WebhookBillingSink({
      endpoint: ENDPOINT,
      signingSecret: SECRET,
      fetchImpl,
      dnsResolver: PUBLIC_RESOLVER,
      backoff: () => 0, // no real delay in tests
    });

    await sink.recordMetering(EVENT);

    expect(calls).toHaveLength(3);
    // Same X-Metering-Id across retries → recipient dedup key.
    const ids = new Set(calls.map((c) => c.headers["x-metering-id"]));
    expect(ids.size).toBe(1);
  });

  it("retries on network error then succeeds", async () => {
    let i = 0;
    const calls: CapturedReq[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const h = new Headers(init?.headers);
      const headers: Record<string, string> = {};
      h.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      calls.push({
        url,
        method: init?.method ?? "GET",
        headers,
        body: typeof init?.body === "string" ? init.body : "",
      });
      i++;
      if (i === 1) throw new Error("connection refused");
      return new Response("ok", { status: 200 });
    };
    const sink = new WebhookBillingSink({
      endpoint: ENDPOINT,
      signingSecret: SECRET,
      fetchImpl,
      dnsResolver: PUBLIC_RESOLVER,
      backoff: () => 0,
    });

    await sink.recordMetering(EVENT);
    expect(calls).toHaveLength(2);
  });

  it("drops after exhausting retries (never throws)", async () => {
    const { fetchImpl, calls } = makeFetch([500, 500, 500, 500, 500]);
    const sink = new WebhookBillingSink({
      endpoint: ENDPOINT,
      signingSecret: SECRET,
      fetchImpl,
      dnsResolver: PUBLIC_RESOLVER,
      maxAttempts: 5,
      backoff: () => 0,
    });

    await expect(sink.recordMetering(EVENT)).resolves.toBeUndefined();
    expect(calls).toHaveLength(5);
  });

  it("rejects a non-https endpoint at construction", () => {
    expect(
      () =>
        new WebhookBillingSink({
          endpoint: "http://billing.example.local/metering",
          signingSecret: SECRET,
          fetchImpl: fetch,
        }),
    ).toThrow(/https:/);
  });

  // --- W8.2: SSRF-pinned egress -------------------------------------------

  it("never posts when the endpoint resolves to a private IP (terminal, no retries)", async () => {
    const { fetchImpl, calls } = makeFetch([200]);
    const sink = new WebhookBillingSink({
      endpoint: ENDPOINT,
      signingSecret: SECRET,
      fetchImpl,
      dnsResolver: PRIVATE_RESOLVER, // 169.254.169.254 — cloud metadata
      maxAttempts: 5,
      backoff: () => 0,
    });

    // Never throws (metering is best-effort) and never reaches the transport.
    await expect(sink.recordMetering(EVENT)).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("never posts to a disallowed port (only 80/443 are permitted)", async () => {
    const { fetchImpl, calls } = makeFetch([200]);
    const sink = new WebhookBillingSink({
      endpoint: "https://billing.example.local:8443/metering",
      signingSecret: SECRET,
      fetchImpl,
      dnsResolver: PUBLIC_RESOLVER,
      maxAttempts: 5,
      backoff: () => 0,
    });

    await expect(sink.recordMetering(EVENT)).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("defaultBillingBackoff grows and caps", () => {
    expect(defaultBillingBackoff(1)).toBe(5_000);
    expect(defaultBillingBackoff(2)).toBe(10_000);
    expect(defaultBillingBackoff(20)).toBeLessThanOrEqual(10 * 60 * 1000);
  });
});
