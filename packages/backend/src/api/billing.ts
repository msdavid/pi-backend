/**
 * Tenant billing routes (console spec §11.8, WP-C5.1) — the saas balance surface.
 *
 * - `GET  /v1/tenant/billing` — balance + lifecycle + verification state
 *   ({@link TenantBillingState}). Drives Home's balance element and the
 *   Settings → Billing panel; `suspended`/unverified states key off it.
 * - `GET  /v1/tenant/billing/ledger` — the append-only ledger history (§11.3),
 *   newest first, cursor-paginated.
 * - `POST /v1/tenant/billing/verification/resend` — resend the trial
 *   verification email (§11.1). No-op once verified.
 *
 * All money is server-computed (§11.9); these routes only ever return what the
 * ledger reports. Reads never call a payment engine. Tenant-scoped: RLS pins the
 * ledger reads to the caller's tenant.
 *
 * **Adapter link-out proxy (§11.7–11.8, WP-C5.3).** The four
 * `/v1/tenant/billing/{checkout,portal,auto-charge}` routes are a thin, **SDK-free**
 * proxy: they authenticate the tenant here, then FORWARD to the billing-adapter's
 * internal surface over the machine channel (`config.billingAdapterUrl` +
 * `billingProvisionToken`), relaying a URL string or the auto-charge settings object.
 * The backend NEVER imports a payment SDK — it only HTTP-calls the adapter. When no
 * adapter is configured every one of the four routes returns `404 no_adapter`, which
 * the console reads as "no adapter" and renders the money-controls-absent state
 * (§11.8). No money math and no ledger write happen here.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  AutoChargeConfig,
  AutoChargeUpdate,
  BillingHostedLink,
  CheckoutSessionRequest,
} from "@pi-managed/contracts";
import { requireScopeByMethod } from "./middleware/scope.js";
import { type Pool } from "../infra/db/index.js";
import { ApiError } from "../domain/errors.js";
import {
  parseListParams,
  paginate,
  encodeCursor,
  decodeCursor,
} from "./middleware/pagination.js";
import {
  getBillingState,
  listLedgerEntries,
  resendVerification,
  type LedgerCursor,
} from "../domain/billing/index.js";
import type { EmailSender } from "../domain/ports.js";

/** Machine-channel coordinates for the billing-adapter internal surface (§11.7). */
export interface BillingAdapterProxy {
  /** The adapter internal surface base URL (`config.billingAdapterUrl`). */
  baseUrl: string;
  /** The shared machine secret presented as `Bearer` (`config.billingProvisionToken`). */
  provisionToken: string;
  /** `fetch` impl; defaults to the global (real HTTP to the adapter process). */
  fetchImpl?: typeof fetch;
}

export interface BillingRoutesOptions {
  pool: Pool;
  emailSender: EmailSender;
  /** Present only when the deployment fronts the billing adapter (else the four
   * link-out routes 404 as the no-adapter state, §11.8). */
  adapter?: BillingAdapterProxy;
}

/** Adapter internal-surface paths (mirror `billing-adapter`'s `internal-api.ts`). */
const ADAPTER_CHECKOUT_PATH = "/internal/adapter/checkout";
const ADAPTER_PORTAL_PATH = "/internal/adapter/portal";
const ADAPTER_AUTO_CHARGE_PATH = "/internal/adapter/auto-charge";

/**
 * Forward one request to the adapter internal surface over the machine channel and
 * return its parsed JSON. A 2xx yields the body; an adapter 4xx is surfaced as the
 * same `ApiError` status (so the console sees its own validation/conflict errors); a
 * 401/5xx or a transport failure is a `502 bad_gateway` (an infra problem, never the
 * tenant's fault, and never leaks the adapter's response).
 */
async function forwardToAdapter(
  adapter: BillingAdapterProxy,
  method: "GET" | "POST" | "PATCH",
  path: string,
  init: { query?: Record<string, string>; body?: unknown } = {},
): Promise<unknown> {
  const fetchImpl = adapter.fetchImpl ?? fetch;
  const qs = init.query ? `?${new URLSearchParams(init.query).toString()}` : "";
  const url = `${adapter.baseUrl.replace(/\/+$/, "")}${path}${qs}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${adapter.provisionToken}`,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    throw new ApiError(502, "internal_error", "billing adapter unreachable");
  }
  if (res.ok) {
    return res.json();
  }
  // The adapter's own machine auth failing (401) is a backend misconfiguration, not a
  // tenant error — never pass it through as an auth failure. 5xx is likewise infra.
  if (res.status === 401 || res.status >= 500) {
    throw new ApiError(502, "internal_error", "billing adapter error");
  }
  let detail: { message?: string } = {};
  try {
    detail = (await res.json()) as { message?: string };
  } catch {
    /* no body */
  }
  // Map the adapter's 4xx to a valid error code by status (never forward its raw
  // error string, which is not part of this API's taxonomy).
  const code = res.status === 409 ? "conflict" : "invalid_request";
  throw new ApiError(res.status, code, detail.message ?? "billing adapter rejected the request");
}

/** Resolve the authenticated tenant context or throw 401. */
function requireCtx(req: FastifyRequest) {
  const ctx = req.tenantCtx;
  if (!ctx) {
    throw new ApiError(401, "unauthorized", "missing tenant context");
  }
  return ctx;
}

export const billingRoutes: FastifyPluginAsync<BillingRoutesOptions> = async (app, opts) => {
  // GET/HEAD → read, mutating → write (the resend is a `write`-scoped action).
  app.addHook("preHandler", requireScopeByMethod);

  // GET /v1/tenant/billing — balance + lifecycle + verification state.
  app.get("/v1/tenant/billing", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    const state = await getBillingState(opts.pool, ctx.tenantId);
    if (!state) {
      // Tenant not enrolled in the ledger (e.g. billing not provisioned) — the
      // console treats this as "no adapter / no billing", §11.8.
      throw new ApiError(404, "not_found", "no billing state for this tenant");
    }
    return reply.status(200).send(state);
  });

  // GET /v1/tenant/billing/ledger — append-only history, newest first.
  app.get("/v1/tenant/billing/ledger", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    const { limit, cursor } = parseListParams(req);
    let before: LedgerCursor | undefined;
    if (cursor) {
      try {
        before = decodeCursor<LedgerCursor>(cursor);
      } catch {
        throw new ApiError(400, "invalid_request", "invalid ledger cursor");
      }
    }
    const rows = await listLedgerEntries(opts.pool, ctx, limit + 1, before);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : undefined;
    return reply.status(200).send(paginate(page, nextCursor));
  });

  // POST /v1/tenant/billing/verification/resend — resend the verification email.
  app.post(
    "/v1/tenant/billing/verification/resend",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(req);
      const { sent } = await resendVerification(opts.pool, ctx.tenantId, opts.emailSender);
      return reply.status(202).send({ sent });
    },
  );

  // --- Adapter link-out proxy (§11.7–11.8) --------------------------------
  // Absent an adapter, every route below is the no-adapter state: 404 no_adapter,
  // which the console reads as "no adapter" (money controls absent). Present, they
  // forward to the adapter over the machine channel (never a payment SDK here).
  const requireAdapter = (): BillingAdapterProxy => {
    if (!opts.adapter) {
      // 404 IS the no-adapter signal (§11.8): the console keys off the status and
      // renders the money-controls-absent state; it never inspects the code here.
      throw new ApiError(404, "not_found", "no billing adapter configured");
    }
    return opts.adapter;
  };

  // GET /v1/tenant/billing/auto-charge — auto-charge config AND adapter-presence probe.
  app.get("/v1/tenant/billing/auto-charge", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    const adapter = requireAdapter();
    const body = await forwardToAdapter(adapter, "GET", ADAPTER_AUTO_CHARGE_PATH, {
      query: { tenantId: ctx.tenantId },
    });
    return reply.status(200).send(AutoChargeConfig.parse(body));
  });

  // PATCH /v1/tenant/billing/auto-charge — update toggle / threshold / amount (USD in).
  app.patch("/v1/tenant/billing/auto-charge", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    const adapter = requireAdapter();
    const parsed = AutoChargeUpdate.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ApiError(422, "invalid_request", "invalid auto-charge update");
    }
    const body = await forwardToAdapter(adapter, "PATCH", ADAPTER_AUTO_CHARGE_PATH, {
      body: { tenantId: ctx.tenantId, ...parsed.data },
    });
    return reply.status(200).send(AutoChargeConfig.parse(body));
  });

  // POST /v1/tenant/billing/checkout — issue a hosted top-up checkout URL.
  app.post("/v1/tenant/billing/checkout", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    const adapter = requireAdapter();
    const parsed = CheckoutSessionRequest.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ApiError(422, "invalid_request", "invalid checkout request");
    }
    const body = await forwardToAdapter(adapter, "POST", ADAPTER_CHECKOUT_PATH, {
      body: { tenantId: ctx.tenantId, ...parsed.data },
    });
    return reply.status(200).send(BillingHostedLink.parse(body));
  });

  // POST /v1/tenant/billing/portal — issue a hosted receipts / payment-method portal URL.
  app.post("/v1/tenant/billing/portal", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    const adapter = requireAdapter();
    const body = await forwardToAdapter(adapter, "POST", ADAPTER_PORTAL_PATH, {
      body: { tenantId: ctx.tenantId },
    });
    return reply.status(200).send(BillingHostedLink.parse(body));
  });
};
