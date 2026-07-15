/**
 * Files API routes (WP-1.12, §8.9, §21, §16.6, §24.8).
 *
 * - `POST   /v1/files`                — upload (multipart; `Idempotency-Key`).
 * - `GET    /v1/files`                — list (paginated; `?sessionId=` filter).
 * - `GET    /v1/files/:id`            — retrieve metadata.
 * - `GET    /v1/files/:id/content`    — download content (raw stream).
 * - `DELETE /v1/files/:id`            — hard delete (204, §21).
 * - `GET    /v1/sessions/:id/outputs`           — list an idle session's outputs.
 * - `GET    /v1/sessions/:id/outputs/:filename` — download an output file.
 *
 * Multipart parsing is implemented inline (no `@fastify/multipart` dependency): a
 * content-type parser collects the raw body buffer, then {@link parseMultipart}
 * splits it on the `--boundary` delimiter. Validation delegates to the
 * `@pi-managed/contracts` zod schemas; every route relies on the auth middleware
 * having set `request.tenantCtx`. Idempotency replay is applied globally by the
 * P0.5 middleware; the POST only needs to require the header here.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { requireScopeByMethod } from "./middleware/scope.js";
import { Readable } from "node:stream";
import { Metadata, type Metadata as MetadataType } from "@pi-managed/contracts";
import { type Pool } from "../infra/db/index.js";
import { ApiError } from "../domain/errors.js";
import { parseListParams, paginate } from "./middleware/pagination.js";
import type { ObjectStore, SandboxProvider } from "../domain/ports.js";
import type { TenantCtx } from "../infra/db/pool.js";
import {
  uploadFile,
  listFiles,
  getFile,
  downloadFile,
  deleteFile,
  listSessionOutputs,
  downloadSessionOutput,
  type SessionSandboxResolver,
} from "../domain/file/index.js";

export interface FileRoutesOptions {
  pool: Pool;
  /** Object store for file content (§28). */
  objectStore: ObjectStore;
  /** Sandbox provider for session-outputs reads (§24.8). Required for outputs routes. */
  sandboxProvider?: SandboxProvider;
  /** Resolves the sandbox handle for a session. Required for outputs routes. */
  sandboxResolver?: SessionSandboxResolver;
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
 * Parse a `multipart/form-data` body buffer into named parts. Splits on the
 * `--<boundary>` delimiter; each part is `\r\n<headers>\r\n\r\n<body>\r\n`. The
 * closing delimiter (`--<boundary>--`) terminates the parse.
 */
function parseMultipart(buffer: Buffer, boundary: string): Map<string, MultipartPart> {
  const parts = new Map<string, MultipartPart>();
  const delim = Buffer.from(`--${boundary}`);
  let start = 0;
  for (;;) {
    const idx = buffer.indexOf(delim, start);
    if (idx === -1) break;
    const afterDelim = idx + delim.length;
    // Closing boundary: `--<boundary>--`
    if (buffer[afterDelim] === 0x2d && buffer[afterDelim + 1] === 0x2d) break;
    // Skip the CRLF that follows the opening delimiter.
    const partStart = afterDelim + 2;
    const nextIdx = buffer.indexOf(delim, partStart);
    if (nextIdx === -1) break;
    // The part body ends at the CRLF preceding the next delimiter.
    const partEnd = nextIdx - 2;
    const partBuf = buffer.subarray(partStart, partEnd < partStart ? partStart : partEnd);
    const sep = partBuf.indexOf("\r\n\r\n");
    start = nextIdx;
    if (sep === -1) continue;
    const headerStr = partBuf.subarray(0, sep).toString("utf8");
    // A view over the raw body — not a copy — so the payload is held at most once (PERF-5).
    const data = partBuf.subarray(sep + 4);
    const name = /name="([^"]*)"/.exec(headerStr)?.[1];
    if (!name) continue;
    const filename = /filename="([^"]*)"/.exec(headerStr)?.[1];
    const ct = /content-type:\s*([^\r\n]+)/i.exec(headerStr)?.[1]?.trim();
    parts.set(name, { filename, contentType: ct, data });
  }
  return parts;
}

export const fileRoutes: FastifyPluginAsync<FileRoutesOptions> = async (app, opts) => {
  // R0.1: enforce API-key scopes on every route in this plugin (GET/HEAD → read,
  // mutating → write; `admin` passes all; worker keys are denied here).
  app.addHook("preHandler", requireScopeByMethod);
  // Collect the raw multipart body as a Buffer (no @fastify/multipart dep).
  app.addContentTypeParser(
    "multipart/form-data",
    { parseAs: "buffer", bodyLimit: 100 * 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );

  // POST /v1/files — upload (multipart; Idempotency-Key required).
  app.post("/v1/files", async (req: FastifyRequest, reply: FastifyReply) => {
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
    const parts = parseMultipart(buffer, boundary);
    const filePart = parts.get("file");
    if (!filePart) {
      throw new ApiError(400, "invalid_request", "missing 'file' part");
    }
    const name = filePart.filename ?? "file";
    if (!name || name.length > 128) {
      throw new ApiError(422, "invalid_request", "file name must be 1–128 chars");
    }

    let metadata: MetadataType | undefined;
    const metaPart = parts.get("metadata");
    if (metaPart && metaPart.data.length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(metaPart.data.toString("utf8"));
      } catch {
        throw new ApiError(400, "invalid_request", "metadata must be valid JSON");
      }
      const result = Metadata.safeParse(parsed);
      if (!result.success) {
        throw new ApiError(
          422,
          "invalid_request",
          `invalid metadata: ${result.error.issues.map((i) => i.message).join("; ")}`,
        );
      }
      metadata = result.data;
    }

    let sessionId: string | undefined;
    const sessionPart = parts.get("sessionId");
    if (sessionPart && sessionPart.data.length > 0) {
      sessionId = sessionPart.data.toString("utf8").trim();
    }

    const file = await uploadFile(opts.pool, ctx, opts.objectStore, {
      name,
      contentType: filePart.contentType,
      stream: new Response(filePart.data).body as ReadableStream<Uint8Array>,
      sessionId,
      metadata,
    });
    return reply.status(201).send(file);
  });

  // GET /v1/files — list (paginated; ?sessionId= filter).
  app.get("/v1/files", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    const { limit, cursor } = parseListParams(req);
    const q = (req.query ?? {}) as { sessionId?: string };
    const result = await listFiles(opts.pool, ctx, {
      limit,
      cursor,
      sessionId: q.sessionId,
    });
    return reply.status(200).send(paginate(result.data, result.nextCursor ?? undefined));
  });

  // GET /v1/files/:id — retrieve metadata.
  app.get("/v1/files/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    const file = await getFile(opts.pool, ctx, id);
    if (!file) {
      throw new ApiError(404, "not_found", `file not found: ${id}`);
    }
    return reply.status(200).send(file);
  });

  // GET /v1/files/:id/content — download content (raw stream).
  app.get(
    "/v1/files/:id/content",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = requireCtx(req);
      const { id } = req.params as { id: string };
      const { file, stream } = await downloadFile(opts.pool, ctx, opts.objectStore, id);
      reply.header("content-type", file.contentType ?? "application/octet-stream");
      reply.header("content-length", String(file.sizeBytes));
      return reply.send(Readable.fromWeb(stream));
    },
  );

  // DELETE /v1/files/:id — hard delete (204, §21).
  app.delete("/v1/files/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCtx(req);
    const { id } = req.params as { id: string };
    const deleted = await deleteFile(opts.pool, ctx, opts.objectStore, id);
    if (!deleted) {
      throw new ApiError(404, "not_found", `file not found: ${id}`);
    }
    return reply.status(204).send();
  });

  // --- Session outputs (§16.6, §24.8) -------------------------------------
  // Registered only when a sandbox provider + resolver are wired. The minimal
  // slice reads outputs live from an idle session's sandbox via exec.
  if (opts.sandboxProvider && opts.sandboxResolver) {
    app.get(
      "/v1/sessions/:id/outputs",
      async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = requireCtx(req);
        const { id } = req.params as { id: string };
        const result = await listSessionOutputs(
          opts.pool,
          ctx,
          opts.sandboxProvider!,
          opts.sandboxResolver!,
          id,
        );
        return reply.status(200).send(result);
      },
    );

    app.get(
      "/v1/sessions/:id/outputs/:filename",
      async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = requireCtx(req);
        const { id, filename } = req.params as { id: string; filename: string };
        const { stream } = await downloadSessionOutput(
          opts.pool,
          ctx,
          opts.sandboxProvider!,
          opts.sandboxResolver!,
          id,
          filename,
        );
        reply.header("content-type", "application/octet-stream");
        return reply.send(Readable.fromWeb(stream));
      },
    );
  }
};
