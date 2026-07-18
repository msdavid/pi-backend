/**
 * Adapter internal HTTP surface (console spec §11.7–11.8, WP-C5.3 F4) — the
 * machine-authenticated seam the backend's SDK-free `/v1` billing proxy calls to
 * reach the payment engine.
 *
 * The adapter runs as a SEPARATE process (see `deploy.md`); this is its inbound
 * surface. It mirrors the credit-surface trust posture EXACTLY (`api/billing-
 * internal.ts`): a per-deployment shared secret in the host-agent bearer pattern
 * (`Authorization: Bearer <BILLING_PROVISION_TOKEN>`), SHA-256-digested and
 * constant-time compared, **fail-closed** — a missing/blank expected secret rejects
 * every request. It is emphatically NOT a tenant API key: the backend authenticates
 * the tenant on its `/v1` route, then forwards over this machine channel. The Stripe
 * SDK stays behind the {@link PaymentEngine} seam here and never enters the backend.
 *
 * Routes (all machine-authed; the backend forwards the tenant id it resolved):
 *  - `POST  /internal/adapter/checkout`    `{ tenantId, amountUsd }` → `{ url }`
 *  - `POST  /internal/adapter/portal`      `{ tenantId }`            → `{ url }`
 *  - `GET   /internal/adapter/auto-charge?tenantId=…`                → `AutoChargeConfig`
 *  - `PATCH /internal/adapter/auto-charge` `{ tenantId, … }`         → `AutoChargeConfig`
 *
 * These issue URLs / read-write config only — **no money math and no ledger write**.
 * Money still enters the ledger solely via the webhook → credit-surface path.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AutoChargeConfig as ContractAutoChargeConfig } from "@pi-managed/contracts";
import type { AutoChargeConfig, AutoChargeStore } from "./auto-charge.js";
import { microsFromUsd, usdFromMicros } from "./money.js";

/** Machine-surface route paths (the backend proxy posts to these). */
export const ADAPTER_CHECKOUT_PATH = "/internal/adapter/checkout";
export const ADAPTER_PORTAL_PATH = "/internal/adapter/portal";
export const ADAPTER_AUTO_CHARGE_PATH = "/internal/adapter/auto-charge";

/** Minimal logger surface (matches the project's pino usage; never receives secrets). */
export interface AdapterInternalLogger {
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** The engine operations the surface issues URLs through (the {@link BillingAdapter} slice). */
export interface AdapterUrlIssuer {
  createCheckoutUrl(tenantId: string, amountMicros: number): Promise<string>;
  createPortalUrl(tenantId: string, customerRef: string): Promise<string>;
}

export interface AdapterInternalDeps {
  /** Issues checkout / portal URLs (a wired {@link BillingAdapter}). */
  adapter: AdapterUrlIssuer;
  /** Auto-charge config store (read for GET/portal, upsert for PATCH). */
  store: AutoChargeStore;
  /** The machine shared secret (`BILLING_PROVISION_TOKEN`). Blank ⇒ reject all. */
  provisionToken: string;
  logger?: AdapterInternalLogger;
}

/** Constant-time bearer check against the machine secret (host-agent pattern). */
function isValidMachineToken(authorization: string | undefined, expected: string): boolean {
  if (!expected) return false; // fail closed: no secret configured ⇒ reject all.
  if (!authorization) return false;
  const match = /^Bearer[ ]+(.+)$/i.exec(authorization.trim());
  if (!match) return false;
  const presented = match[1];
  if (!presented) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** The default OFF config a tenant with no saved auto-charge presents (§11.7). */
const DEFAULT_OFF: AutoChargeConfig = {
  enabled: false,
  thresholdMicros: 0,
  amountMicros: 0,
  dailyCapMicros: 0,
  monthlyCapMicros: 0,
  customerRef: "",
  paymentMethodRef: "",
};

/**
 * Map the adapter-internal config to the console-facing contract shape: add the
 * server-divided `*Usd` companions (§11.9). `lastCharge*` / `disabledReason` are
 * null in the reference store (a production store surfaces them).
 */
function toContractConfig(cfg: AutoChargeConfig | null): ContractAutoChargeConfig {
  const c = cfg ?? DEFAULT_OFF;
  return {
    enabled: c.enabled,
    thresholdMicros: c.thresholdMicros,
    thresholdUsd: usdFromMicros(c.thresholdMicros),
    amountMicros: c.amountMicros,
    amountUsd: usdFromMicros(c.amountMicros),
    dailyCapMicros: c.dailyCapMicros,
    dailyCapUsd: usdFromMicros(c.dailyCapMicros),
    monthlyCapMicros: c.monthlyCapMicros,
    monthlyCapUsd: usdFromMicros(c.monthlyCapMicros),
    lastChargeAt: null,
    lastChargeUsd: null,
    disabledReason: null,
  };
}

/** A non-empty string, or `undefined`. */
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** A finite non-negative number, or `undefined`. */
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** Build the request handler for the adapter internal surface (framework-agnostic). */
export function createAdapterInternalHandler(
  deps: AdapterInternalDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { adapter, store, provisionToken, logger } = deps;

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const rawUrl = req.url ?? "";
    const url = new URL(rawUrl, "http://adapter.internal");
    const path = url.pathname;

    const send = (code: number, body?: unknown): void => {
      if (body === undefined) {
        res.statusCode = code;
        res.end();
        return;
      }
      res.statusCode = code;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    };
    const fail = (code: number, error: string, message: string): void =>
      send(code, { error, message });

    // Machine auth on EVERY request, before any work. A tenant key never authenticates.
    if (!isValidMachineToken(req.headers.authorization, provisionToken)) {
      return send(401, { error: "unauthorized", message: "invalid or missing machine credential" });
    }

    const read = async (): Promise<Record<string, unknown>> => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return {};
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    };

    try {
      if (method === "POST" && path === ADAPTER_CHECKOUT_PATH) {
        const body = await read();
        const tenantId = str(body.tenantId);
        if (!tenantId) return fail(422, "invalid_request", "tenantId is required");
        const amountUsd = num(body.amountUsd);
        // The reference engine issues a FIXED-amount hosted page, so an explicit
        // top-up amount is required (the console's top-up dialog always sends one).
        if (amountUsd === undefined || amountUsd <= 0) {
          return fail(422, "invalid_request", "amountUsd (positive) is required by the reference engine");
        }
        const target = await adapter.createCheckoutUrl(tenantId, microsFromUsd(amountUsd));
        return send(200, { url: target });
      }

      if (method === "POST" && path === ADAPTER_PORTAL_PATH) {
        const body = await read();
        const tenantId = str(body.tenantId);
        if (!tenantId) return fail(422, "invalid_request", "tenantId is required");
        // The saved-customer handle lives on the tenant's auto-charge config in the
        // reference store (a production store maps customer↔tenant independently).
        const cfg = await store.getConfig(tenantId);
        const customerRef = cfg ? str(cfg.customerRef) : undefined;
        if (!customerRef) {
          // NOT 404 — the console reads 404 as "no adapter". A missing saved card is
          // a per-tenant conflict, not an absent adapter.
          return fail(409, "no_saved_customer", "no saved payment method for this tenant");
        }
        const target = await adapter.createPortalUrl(tenantId, customerRef);
        return send(200, { url: target });
      }

      if (method === "GET" && path === ADAPTER_AUTO_CHARGE_PATH) {
        const tenantId = str(url.searchParams.get("tenantId"));
        if (!tenantId) return fail(422, "invalid_request", "tenantId is required");
        // Adapter present but tenant unconfigured ⇒ default-OFF (200), never 404 —
        // 404 is reserved for "no adapter", generated by the backend proxy.
        const cfg = await store.getConfig(tenantId);
        return send(200, toContractConfig(cfg));
      }

      if (method === "PATCH" && path === ADAPTER_AUTO_CHARGE_PATH) {
        const body = await read();
        const tenantId = str(body.tenantId);
        if (!tenantId) return fail(422, "invalid_request", "tenantId is required");
        const patch: { enabled?: boolean; thresholdMicros?: number; amountMicros?: number } = {};
        if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
        const thresholdUsd = num(body.thresholdUsd);
        if (thresholdUsd !== undefined) patch.thresholdMicros = microsFromUsd(thresholdUsd);
        const amountUsd = num(body.amountUsd);
        if (amountUsd !== undefined) patch.amountMicros = microsFromUsd(amountUsd);
        const updated = await store.updateConfig(tenantId, patch);
        return send(200, toContractConfig(updated));
      }

      return fail(404, "not_found", "unknown adapter route");
    } catch (err) {
      logger?.error({ err: (err as Error).message }, "adapter internal surface error");
      return fail(500, "internal_error", "adapter internal surface error");
    }
  };
}

/** Create the (not-yet-listening) HTTP server for the adapter internal surface. */
export function createAdapterInternalServer(deps: AdapterInternalDeps): http.Server {
  const handler = createAdapterInternalHandler(deps);
  return http.createServer((req, res) => {
    void handler(req, res);
  });
}
