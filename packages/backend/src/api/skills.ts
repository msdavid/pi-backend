/**
 * Skills API routes (WP-3.5, §8.10, §20).
 *
 * - `POST   /v1/skills`             — upload (zip or individual files; `Idempotency-Key`).
 * - `GET    /v1/skills`             — list (paginated; `?type=` filter).
 * - `GET    /v1/skills/:id`         — retrieve.
 * - `GET    /v1/skills/:id/versions`— list versions.
 * - `DELETE /v1/skills/:id`         — delete (204).
 *
 * Multipart parsing is inline (no `@fastify/multipart`): a content-type parser
 * collects the raw body buffer, then {@link parseMultipartParts} splits it on
 * `--boundary`. A single `file` part whose content sniffs as a ZIP is extracted
 * into many files; otherwise every `file` part is treated as a loose bundle
 * file. Validation delegates to the `@pi-managed/contracts` zod schemas;
 * `request.tenantCtx` is set by the auth middleware. Idempotency replay is
 * applied globally by the P0.5 middleware; the POST only requires the header.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { requireScopeByMethod } from "./middleware/scope.js";
import { type Pool } from "../infra/db/index.js";
import { ApiError } from "../domain/errors.js";
import { parseListParams, paginate } from "./middleware/pagination.js";
import type { ObjectStore } from "../domain/ports.js";
import type { TenantCtx } from "../infra/db/pool.js";
import type { SkillType } from "@pi-managed/contracts";
import {
  uploadSkill,
  listSkills,
  getSkill,
  listVersions,
  deleteSkill,
  collectBundleFiles,
  isZipBuffer,
  type BundleFile,
} from "../domain/skill/index.js";

export interface SkillRoutesOptions {
  pool: Pool;
  /** Object store for skill bundles (§28). */
  objectStore: ObjectStore;
}

/** Resolve the authenticated tenant context or throw 401. */
function requireCtx(req: FastifyRequest): TenantCtx {
  const ctx = req.tenantCtx;
  if (!ctx) {
    throw new ApiError(401, "unauthorized", "missing tenant context");
  }
  return ctx;
}

/** Require a non-empty `Idempotency-Key` header (POST endpoints). */
function requireIdempotencyKey(req: FastifyRequest): void {
  const key = req.headers["idempotency-key"];
  if (!key || Array.isArray(key) || String(key).trim() === "") {
    throw new ApiError(400, "invalid_request", "Idempotency-Key header is required");
  }
}

/** A parsed multipart form part. */
interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

/** Extract the `boundary` from a `multipart/form-data` Content-Type header. */
function extractBoundary(header: string): string | null {
  const m = /boundary=([^;]+)/i.exec(header);
  if (!m) return null;
  return m[1].trim().replace(/^"|"$/g, "");
}

/**
 * Parse a `multipart/form-data` body into an **array** of parts (unlike the
 * Files parser's Map — skills accept multiple `file` parts). Splits on
 * `--<boundary>`; the closing delimiter (`--<boundary>--`) terminates the parse.
 */
function parseMultipartParts(buffer: Buffer, boundary: string): MultipartPart[] {
  const parts: MultipartPart[] = [];
  const delim = Buffer.from(`--${boundary}`);
  let start = 0;
  for (;;) {
    const idx = buffer.indexOf(delim, start);
    if (idx === -1) break;
    const afterDelim = idx + delim.length;
    if (buffer[afterDelim] === 0x2d && buffer[afterDelim + 1] === 0x2d) break;
    const partStart = afterDelim + 2;
    const nextIdx = buffer.indexOf(delim, partStart);
    if (nextIdx === -1) break;
    const partEnd = nextIdx - 2;
    const partBuf = buffer.subarray(partStart, partEnd < partStart ? partStart : partEnd);
    const sep = partBuf.indexOf("\r\n\r\n");
    start = nextIdx;
    if (sep === -1) continue;
    const headerStr = partBuf.subarray(0, sep).toString("utf8");
    const data = Buffer.from(partBuf.subarray(sep + 4));
    const name = /name="([^"]*)"/.exec(headerStr)?.[1];
    if (!name) continue;
    const filename = /filename="([^"]*)"/.exec(headerStr)?.[1];
    const ct = /content-type:\s*([^\r\n]+)/i.exec(headerStr)?.[1]?.trim();
    parts.push({ name, filename, contentType: ct, data });
  }
  return parts;
}

export const skillRoutes: FastifyPluginAsync<SkillRoutesOptions> = async (app, opts) => {
  // R0.1: enforce API-key scopes on every route in this plugin (GET/HEAD → read,
  // mutating → write; `admin` passes all; worker keys are denied here).
  app.addHook("preHandler", requireScopeByMethod);
  // Collect the raw multipart body as a Buffer (no @fastify/multipart dep).
  app.addContentTypeParser(
    "multipart/form-data",
    { parseAs: "buffer", bodyLimit: 50 * 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );

  // POST /v1/skills — upload (zip or individual files; Idempotency-Key required).
  app.post("/v1/skills", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    requireIdempotencyKey(req);
    const buffer = req.body as Buffer | undefined;
    if (!Buffer.isBuffer(buffer)) {
      throw new ApiError(400, "invalid_request", "expected multipart/form-data body");
    }
    const ct = req.headers["content-type"] ?? "";
    const boundary = extractBoundary(ct);
    if (!boundary) {
      throw new ApiError(400, "invalid_request", "missing multipart boundary");
    }
    const parts = parseMultipartParts(buffer, boundary);

    let displayTitle: string | undefined;
    const loose: BundleFile[] = [];
    let zip: Buffer | null = null;
    let zipSeen = false;
    for (const p of parts) {
      if (p.name === "displayTitle" && p.data.length > 0) {
        displayTitle = p.data.toString("utf8").trim();
      } else if (p.name === "file") {
        const name = p.filename ?? "file";
        if (!zipSeen && isZipBuffer(p.data)) {
          zip = p.data;
          zipSeen = true;
        } else if (zipSeen) {
          throw new ApiError(
            422,
            "invalid_request",
            "upload a single zip or multiple individual files, not both",
          );
        } else {
          loose.push({ path: name, data: p.data });
        }
      }
    }
    if (!zip && loose.length === 0) {
      throw new ApiError(400, "invalid_request", "missing 'file' part");
    }
    const files = collectBundleFiles(zip, loose);

    const skill = await uploadSkill(opts.pool, ctx, opts.objectStore, {
      files,
      displayTitle,
      type: "custom",
    });
    return reply.status(201).send(skill);
  });

  // GET /v1/skills — list (paginated; ?type= filter).
  app.get("/v1/skills", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    const { limit, cursor } = parseListParams(req);
    const q = (req.query ?? {}) as { type?: string };
    let type: SkillType | undefined;
    if (q.type === "prebuilt" || q.type === "custom") type = q.type;
    else if (q.type !== undefined) {
      throw new ApiError(400, "invalid_request", "type must be 'prebuilt' or 'custom'");
    }
    const result = await listSkills(opts.pool, ctx, { limit, cursor, type });
    return reply.status(200).send(paginate(result.data, result.nextCursor ?? undefined));
  });

  // GET /v1/skills/:id — retrieve.
  app.get("/v1/skills/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    const skill = await getSkill(opts.pool, ctx, id);
    if (!skill) {
      throw new ApiError(404, "not_found", `skill not found: ${id}`);
    }
    return reply.status(200).send(skill);
  });

  // GET /v1/skills/:id/versions — list versions.
  app.get(
    "/v1/skills/:id/versions",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(req);
      const { id } = req.params as { id: string };
      const versions = await listVersions(opts.pool, ctx, id);
      return reply.status(200).send({ data: versions });
    },
  );

  // DELETE /v1/skills/:id — delete (204).
  app.delete("/v1/skills/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    const deleted = await deleteSkill(opts.pool, ctx, opts.objectStore, id);
    if (!deleted) {
      throw new ApiError(404, "not_found", `skill not found: ${id}`);
    }
    return reply.status(204).send();
  });
};
