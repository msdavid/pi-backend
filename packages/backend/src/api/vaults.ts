/**
 * Vault + credential routes (WP-1.9, api-reference.md §"Vaults").
 *
 * - `POST /v1/vaults` — create vault (`Idempotency-Key` required).
 * - `GET /v1/vaults` / `GET /v1/vaults/:id` — list / retrieve.
 * - `DELETE /v1/vaults/:id` — hard delete (`204`).
 * - `POST /v1/vaults/:id/archive` — archive (cascades; `Idempotency-Key`).
 * - `POST /v1/vaults/:id/credentials` — add credential (`Idempotency-Key`).
 * - `GET /v1/vaults/:id/credentials` — list (no sensitive fields).
 * - `DELETE /v1/vaults/:id/credentials/:key` — archive a credential.
 * - `POST /v1/vaults/:id/credentials/:key/validate` — Phase 2 (`501`).
 *
 * Sensitive fields (`token`, `secretValue`, `accessToken`, `clientSecret`,
 * `refreshToken`) are write-only: they are parsed on create (contract) but
 * NEVER present in any response (§12.4). The domain layer selects only
 * non-sensitive columns, so they cannot leak here.
 *
 * NOTE: the `:key` path param must be percent-encoded by the client when it
 * contains `/` (e.g. a `static_bearer` URL key like `https://api.github.com`).
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { requireScopeByMethod } from "./middleware/scope.js";
import { type Pool } from "../infra/db/index.js";
import { ApiError } from "../domain/errors.js";
import type { VaultCrypto } from "../domain/vault/crypto.js";
import {
  createVault,
  listVaults,
  getVault,
  deleteVault,
  archiveVault,
} from "../domain/vault/vault.js";
import {
  addCredential,
  listCredentials,
  archiveCredential,
} from "../domain/vault/credential.js";
import { validateCredential } from "../domain/vault/validate.js";
import { CredentialCreate, VaultCreate } from "@pi-managed/contracts";

export interface VaultRoutesOptions {
  pool: Pool;
  crypto: VaultCrypto;
}

/** Resolve the authenticated tenant context or throw 401. */
function requireCtx(req: FastifyRequest) {
  const ctx = req.tenantCtx;
  if (!ctx) {
    throw new ApiError(401, "unauthorized", "missing tenant context");
  }
  return ctx;
}

/** Require an `Idempotency-Key` header on mutating POSTs (§"`Idempotency-Key`"). */
function requireIdempotencyKey(req: FastifyRequest) {
  const key = req.headers["idempotency-key"];
  if (!key || typeof key !== "string" || key.trim() === "") {
    throw new ApiError(
      400,
      "invalid_request",
      "Idempotency-Key header is required",
    );
  }
}

/** Format a zod issue list as a single message. */
function zodMessage(issues: { message: string }[]): string {
  return `invalid request body: ${issues.map((i) => i.message).join("; ")}`;
}

export const vaultRoutes: FastifyPluginAsync<VaultRoutesOptions> = async (
  app,
  opts,
) => {
  // R0.1: enforce API-key scopes on every route in this plugin (GET/HEAD → read,
  // mutating → write; `admin` passes all; worker keys are denied here).
  app.addHook("preHandler", requireScopeByMethod);
  // POST /v1/vaults — create vault.
  app.post("/v1/vaults", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    requireIdempotencyKey(req);
    const parsed = VaultCreate.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(422, "invalid_request", zodMessage(parsed.error.issues));
    }
    const vault = await createVault(opts.pool, ctx, parsed.data);
    return reply.status(201).send(vault);
  });

  // GET /v1/vaults — list.
  app.get("/v1/vaults", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    const data = await listVaults(opts.pool, ctx);
    return reply.status(200).send({ data, nextCursor: null });
  });

  // GET /v1/vaults/:id — retrieve.
  app.get(
    "/v1/vaults/:id",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(req);
      const { id } = req.params as { id: string };
      const vault = await getVault(opts.pool, ctx, id);
      return reply.status(200).send(vault);
    },
  );

  // DELETE /v1/vaults/:id — hard delete.
  app.delete(
    "/v1/vaults/:id",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(req);
      const { id } = req.params as { id: string };
      await deleteVault(opts.pool, ctx, id);
      return reply.status(204).send();
    },
  );

  // POST /v1/vaults/:id/archive — archive (cascades to credentials).
  app.post(
    "/v1/vaults/:id/archive",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(req);
      requireIdempotencyKey(req);
      const { id } = req.params as { id: string };
      const vault = await archiveVault(opts.pool, ctx, id);
      return reply.status(200).send(vault);
    },
  );

  // POST /v1/vaults/:id/credentials — add credential.
  app.post(
    "/v1/vaults/:id/credentials",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(req);
      requireIdempotencyKey(req);
      const { id } = req.params as { id: string };
      const parsed = CredentialCreate.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(
          422,
          "invalid_request",
          zodMessage(parsed.error.issues),
        );
      }
      const cred = await addCredential(
        opts.pool,
        ctx,
        opts.crypto,
        id,
        parsed.data,
      );
      return reply.status(201).send(cred);
    },
  );

  // GET /v1/vaults/:id/credentials — list (no sensitive fields).
  app.get(
    "/v1/vaults/:id/credentials",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(req);
      const { id } = req.params as { id: string };
      const data = await listCredentials(opts.pool, ctx, id);
      return reply.status(200).send({ data, nextCursor: null });
    },
  );

  // DELETE /v1/vaults/:id/credentials/:key — archive a credential.
  app.delete(
    "/v1/vaults/:id/credentials/:key",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(req);
      const { id, key } = req.params as { id: string; key: string };
      const res = await archiveCredential(opts.pool, ctx, id, key);
      return reply.status(200).send({ id: res.id, status: res.status });
    },
  );

  // POST /v1/vaults/:id/credentials/:key/validate — Phase 2 (§12.5).
  // Returns the `valid` | `invalid` | `unknown` taxonomy.
  app.post(
    "/v1/vaults/:id/credentials/:key/validate",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(req);
      const { id, key } = req.params as { id: string; key: string };
      const status = await validateCredential(
        { pool: opts.pool, tenantCtx: ctx, crypto: opts.crypto, vaultId: id, key },
      );
      return reply.status(200).send({ status });
    },
  );
};
