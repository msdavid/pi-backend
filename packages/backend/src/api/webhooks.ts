/**
 * Webhook routes (WP-2.5, §"Webhooks").
 *
 * - `POST /v1/webhooks` — register (`Idempotency-Key` required); `whsec_` signing
 *   secret returned **once**.
 * - `GET /v1/webhooks` — list (no secret).
 * - `GET /v1/webhooks/:id` — retrieve (no secret); `404` if absent / wrong tenant.
 * - `DELETE /v1/webhooks/:id` — delete; `204` on success, `404` if absent.
 * - `POST /v1/webhooks/:id/test` — send a test event (`Idempotency-Key` required).
 *
 * All routes rely on the auth middleware having set `request.tenantCtx`.
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { requireScopeByMethod } from "./middleware/scope.js";
import { type Pool } from "../infra/db/index.js";
import { ApiError } from "../domain/errors.js";
import {
  createWebhook,
  listWebhooks,
  getWebhook,
  deleteWebhook,
  testDelivery,
  EndpointValidationError,
} from "../domain/webhook/index.js";
import { WebhookCreate } from "@pi-managed/contracts";

export interface WebhookRoutesOptions {
  pool: Pool;
}

/** Resolve the authenticated tenant context or throw 401. */
function requireCtx(req: FastifyRequest) {
  const ctx = req.tenantCtx;
  if (!ctx) {
    throw new ApiError(401, "unauthorized", "missing tenant context");
  }
  return ctx;
}

/** Require + return the `Idempotency-Key` header (§8.8). */
function requireIdempotencyKey(req: FastifyRequest): string {
  const key = req.headers["idempotency-key"];
  if (
    !key ||
    typeof key !== "string" ||
    key.trim() === ""
  ) {
    throw new ApiError(
      400,
      "invalid_request",
      "Idempotency-Key header is required",
    );
  }
  return key;
}

export const webhookRoutes: FastifyPluginAsync<WebhookRoutesOptions> = async (
  app,
  opts,
) => {
  // R0.1: enforce API-key scopes on every route in this plugin (GET/HEAD → read,
  // mutating → write; `admin` passes all; worker keys are denied here).
  app.addHook("preHandler", requireScopeByMethod);
  // POST /v1/webhooks — register endpoint (Idempotency-Key required; secret shown once).
  // `idempotencyNoStore` opts this route out of response-body capture: the raw
  // `whsec_` signing secret must never be persisted in idempotency_keys (§25.1, §8).
  app.post(
    "/v1/webhooks",
    { config: { idempotencyNoStore: true } },
    async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    requireIdempotencyKey(req);
    const parsed = WebhookCreate.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(
        422,
        "invalid_request",
        `invalid request body: ${parsed.error.issues
          .map((i) => i.message)
          .join("; ")}`,
      );
    }
    try {
      const created = await createWebhook(opts.pool, ctx, parsed.data);
      return reply.status(201).send(created);
    } catch (err) {
      if (err instanceof EndpointValidationError) {
        throw new ApiError(422, "invalid_request", err.message);
      }
      throw err;
    }
    },
  );

  // GET /v1/webhooks — list endpoints (no secret).
  app.get("/v1/webhooks", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    const data = await listWebhooks(opts.pool, ctx);
    return reply.status(200).send({ data, nextCursor: null });
  });

  // GET /v1/webhooks/:id — retrieve (no secret).
  app.get(
    "/v1/webhooks/:id",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(req);
      const { id } = req.params as { id: string };
      const wh = await getWebhook(opts.pool, ctx, id);
      if (!wh) {
        throw new ApiError(404, "not_found", `webhook not found: ${id}`);
      }
      return reply.status(200).send(wh);
    },
  );

  // DELETE /v1/webhooks/:id — delete (204); 404 if absent / wrong tenant.
  app.delete(
    "/v1/webhooks/:id",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(req);
      const { id } = req.params as { id: string };
      const ok = await deleteWebhook(opts.pool, ctx, id);
      if (!ok) {
        throw new ApiError(404, "not_found", `webhook not found: ${id}`);
      }
      return reply.status(204).send();
    },
  );

  // POST /v1/webhooks/:id/test — send a test event (Idempotency-Key required).
  app.post(
    "/v1/webhooks/:id/test",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(req);
      requireIdempotencyKey(req);
      const { id } = req.params as { id: string };
      const result = await testDelivery(opts.pool, ctx, id);
      if (!result.delivered && result.responseCode === undefined) {
        // No request made: webhook absent or disabled.
        const wh = await getWebhook(opts.pool, ctx, id);
        if (!wh) {
          throw new ApiError(404, "not_found", `webhook not found: ${id}`);
        }
      }
      return reply.status(200).send(result);
    },
  );
};
