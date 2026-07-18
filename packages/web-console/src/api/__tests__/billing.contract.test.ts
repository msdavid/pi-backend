// @vitest-environment node
/**
 * Contract tests for the billing client (WP-C5.4; console-spec §11) against the
 * REAL in-process backend (CONVENTIONS.md "Fakes at the seam": testcontainers
 * Postgres + the real Fastify app on an ephemeral port + the real global
 * `fetch`). The subject is the console↔backend billing seam.
 *
 * Scope. Two backend shapes, both real:
 *
 *  - **DEFAULT (billing-disabled, no adapter)** — also the shipped production
 *    shape until a deployment enrols a tenant and fronts the payment adapter.
 *    Pins the degradation paths the console MUST get right (§11.8): "no billing"
 *    (the `GET /v1/tenant/billing` 404 read as absent) and "no adapter" (the
 *    `GET …/auto-charge` route absent ⇒ `getAutoCharge` resolves to `null`, the
 *    single money-controls-off signal). Ledger-pagination + verification-resend
 *    shapes are exercised against the real route too.
 *  - **ADAPTER CONFIGURED** — the backend mounts the real (SDK-free) link-out
 *    proxy (`BILLING_ADAPTER_URL` + `BILLING_PROVISION_TOKEN`) pointed at a fake
 *    adapter HTTP server. The console↔backend proxy is REAL on both sides; only
 *    the payment engine (Stripe) is faked, at the adapter's own seam. Drives the
 *    WITH-adapter fetchers end to end: `getAutoCharge` (non-null), the
 *    `updateAutoCharge` USD→config round-trip, `createCheckout` URL issuance (and
 *    the amount-required 422), and `createPortal` URL issuance.
 *
 * Run with `PI_REQUIRE_INTEGRATION=containers`.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConsoleApiClient, ConsoleApiError } from "../client.js";
import {
  createCheckout,
  createPortal,
  getAutoCharge,
  getBilling,
  getLedger,
  resendVerification,
  updateAutoCharge,
  verifyEmail,
} from "../billing.js";
import { requireContainers, startTestBackend, type TestBackend } from "./harness.js";

const RUNTIME = requireContainers("web-console billing contract suite");

/** A machine secret for the fake adapter channel — NOT a real credential. */
const ADAPTER_TOKEN = "test-only-machine-secret-not-a-real-credential";

/**
 * A fake billing-adapter internal surface: the payment engine (Stripe) stubbed
 * at the adapter's own seam. Machine-bearer-authed like the real one; keeps an
 * in-memory auto-charge config so the PATCH round-trip is observable. The
 * USD↔micros conversion is the ADAPTER's job (done here), never the console's.
 */
async function startFakeAdapter(
  token: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  const config = {
    enabled: false,
    thresholdMicros: 0,
    amountMicros: 0,
    dailyCapMicros: 100_000_000,
    monthlyCapMicros: 500_000_000,
  };
  const toContract = (c: typeof config) => ({
    enabled: c.enabled,
    thresholdMicros: c.thresholdMicros,
    thresholdUsd: c.thresholdMicros / 1_000_000,
    amountMicros: c.amountMicros,
    amountUsd: c.amountMicros / 1_000_000,
    dailyCapMicros: c.dailyCapMicros,
    dailyCapUsd: c.dailyCapMicros / 1_000_000,
    monthlyCapMicros: c.monthlyCapMicros,
    monthlyCapUsd: c.monthlyCapMicros / 1_000_000,
    lastChargeAt: null,
    lastChargeUsd: null,
    disabledReason: null,
  });

  const server = http.createServer((req, res) => {
    void (async () => {
      const send = (code: number, body?: unknown): void => {
        res.statusCode = code;
        if (body === undefined) return void res.end();
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
      };
      // Machine auth on every request; a tenant key never reaches here.
      if (req.headers.authorization !== `Bearer ${token}`) {
        return send(401, { error: "unauthorized" });
      }
      const url = new URL(req.url ?? "", "http://adapter.internal");
      const path = url.pathname;
      const readBody = async (): Promise<Record<string, unknown>> => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const text = Buffer.concat(chunks).toString("utf8");
        return text ? (JSON.parse(text) as Record<string, unknown>) : {};
      };

      if (req.method === "GET" && path === "/internal/adapter/auto-charge") {
        return send(200, toContract(config));
      }
      if (req.method === "PATCH" && path === "/internal/adapter/auto-charge") {
        const b = await readBody();
        if (typeof b.enabled === "boolean") config.enabled = b.enabled;
        if (typeof b.thresholdUsd === "number")
          config.thresholdMicros = Math.round(b.thresholdUsd * 1_000_000);
        if (typeof b.amountUsd === "number")
          config.amountMicros = Math.round(b.amountUsd * 1_000_000);
        return send(200, toContract(config));
      }
      if (req.method === "POST" && path === "/internal/adapter/checkout") {
        const b = await readBody();
        // The reference engine issues a FIXED-amount hosted page → an amount is
        // required (the console always sends one).
        if (typeof b.amountUsd !== "number" || !(b.amountUsd > 0)) {
          return send(422, { error: "invalid_request", message: "amountUsd required" });
        }
        return send(200, { url: `https://pay.example.test/checkout?amount=${b.amountUsd}` });
      }
      if (req.method === "POST" && path === "/internal/adapter/portal") {
        return send(200, { url: "https://pay.example.test/portal" });
      }
      return send(404, { error: "not_found" });
    })().catch(() => {
      res.statusCode = 500;
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe.skipIf(!RUNTIME)("billing client ↔ real backend", () => {
  let backend: TestBackend;
  let admin: ConsoleApiClient;

  beforeAll(async () => {
    backend = await startTestBackend();
    admin = new ConsoleApiClient({
      baseUrl: backend.baseUrl,
      headers: { Authorization: `Bearer ${backend.adminKey}` },
    });
  }, 120_000);

  afterAll(async () => {
    await backend?.stop();
  });

  it("GET /v1/tenant/billing → 404 when the tenant is not enrolled (console reads as 'no billing')", async () => {
    await expect(getBilling(admin)).rejects.toMatchObject({
      status: 404,
    });
    await expect(getBilling(admin)).rejects.toBeInstanceOf(ConsoleApiError);
  });

  it("getAutoCharge → null when no adapter proxy is configured (no-adapter state, §11.8)", async () => {
    // The `/v1/tenant/billing/auto-charge` route is served only by an adapter
    // proxy; absent it the backend 404s and the client maps that to `null`
    // rather than throwing — the single "money controls off" signal.
    await expect(getAutoCharge(admin)).resolves.toBeNull();
  });

  it("GET /v1/tenant/billing/ledger → an empty, well-formed page for a fresh tenant", async () => {
    const page = await getLedger({}, admin);
    expect(page.data).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it("POST …/verification/resend → 202 { sent } through the real write-scoped route", async () => {
    // A non-enrolled tenant has no pending verification, so this is the benign
    // no-op (`sent:false`) — but it proves the client hits the real route, on
    // the CSRF-exempt bearer path, and parses the response schema.
    const result = await resendVerification(admin);
    expect(result).toEqual({ sent: false });
  });

  it("POST /v1/onboarding/verify-email with an unknown token → a parsed error envelope", async () => {
    await expect(
      verifyEmail({ token: "tok_does_not_exist" }, admin),
    ).rejects.toBeInstanceOf(ConsoleApiError);
  });
});

describe.skipIf(!RUNTIME)("billing client ↔ real backend proxy (adapter configured)", () => {
  let backend: TestBackend;
  let adapter: { url: string; close: () => Promise<void> };
  let admin: ConsoleApiClient;

  beforeAll(async () => {
    adapter = await startFakeAdapter(ADAPTER_TOKEN);
    backend = await startTestBackend({
      configEnv: {
        BILLING_ADAPTER_URL: adapter.url,
        BILLING_PROVISION_TOKEN: ADAPTER_TOKEN,
      },
    });
    admin = new ConsoleApiClient({
      baseUrl: backend.baseUrl,
      headers: { Authorization: `Bearer ${backend.adminKey}` },
    });
  }, 120_000);

  afterAll(async () => {
    await backend?.stop();
    await adapter?.close();
  });

  it("getAutoCharge resolves the config (adapter present ⇒ non-null, not the 404 no-adapter signal)", async () => {
    const cfg = await getAutoCharge(admin);
    expect(cfg).not.toBeNull();
    expect(cfg).toMatchObject({ enabled: false });
  });

  it("updateAutoCharge round-trips USD in → config out with consistent micros companions", async () => {
    const cfg = await updateAutoCharge({ enabled: true, thresholdUsd: 5, amountUsd: 20 }, admin);
    expect(cfg.enabled).toBe(true);
    expect(cfg.thresholdUsd).toBe(5);
    expect(cfg.thresholdMicros).toBe(5_000_000);
    expect(cfg.amountUsd).toBe(20);
    expect(cfg.amountMicros).toBe(20_000_000);
  });

  it("createCheckout issues a hosted URL for a positive amount (redirect target, never a card)", async () => {
    const link = await createCheckout({ amountUsd: 25 }, admin);
    expect(link.url).toMatch(/^https:\/\//);
  });

  it("createCheckout with NO amount is rejected 422 — the reference engine requires one (§11.7)", async () => {
    await expect(createCheckout({}, admin)).rejects.toMatchObject({ status: 422 });
  });

  it("createPortal issues a hosted receipts / payment-method URL", async () => {
    const link = await createPortal(admin);
    expect(link.url).toMatch(/^https:\/\//);
  });
});
