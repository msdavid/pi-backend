/**
 * Console static-serve tests (WP-4.5, §26.6).
 *
 * The console hook runs on the *unauthenticated* pre-auth path, so its
 * path-traversal guard is a security boundary: a request must only ever be
 * served a file that lies under the console asset root. SEC-11 — a bare
 * `startsWith(root)` also admits a sibling directory sharing the prefix
 * (`<root>-backup/…`); the guard now requires the root itself or a path under
 * `root + sep`.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConsoleServeHook } from "../console.js";

/** Minimal FastifyReply capturing what the hook sends. */
function mockReply(): {
  reply: FastifyReply;
  record: {
    status: number;
    contentType?: string;
    payload: unknown;
    headers: Record<string, string>;
  };
} {
  const record: {
    status: number;
    contentType?: string;
    payload: unknown;
    headers: Record<string, string>;
  } = {
    status: 200,
    payload: undefined,
    headers: {},
  };
  const reply = {
    status(code: number) {
      record.status = code;
      return this;
    },
    type(ct: string) {
      record.contentType = ct;
      return this;
    },
    header(name: string, value: string) {
      record.headers[name] = value;
      return this;
    },
    send(payload: unknown) {
      record.payload = payload;
      return this;
    },
  } as unknown as FastifyReply;
  return { reply, record };
}

function req(url: string): FastifyRequest {
  // `id` mirrors Fastify's per-request id — the hook stamps it as the
  // envelope's `requestId` (required by the contracts ErrorEnvelope).
  return { url, id: "req-test" } as FastifyRequest;
}

const SECRET = "top-secret-backup-contents";
const APP_JS = "console.app.js.contents";

describe("createConsoleServeHook — path-traversal guard (SEC-11)", () => {
  let base: string;
  let distPath: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "console-test-"));
    distPath = join(base, "dist");
    await mkdir(distPath, { recursive: true });
    await writeFile(join(distPath, "index.html"), "<html>console</html>");
    await writeFile(join(distPath, "app.js"), APP_JS);
    // Sibling directory sharing the `dist` prefix — must never be reachable.
    await mkdir(join(base, "dist-backup"), { recursive: true });
    await writeFile(join(base, "dist-backup", "secret.txt"), SECRET);
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("serves a legitimate asset under the root", async () => {
    const hook = createConsoleServeHook({ distPath });
    const { reply, record } = mockReply();
    await hook(req("/console/app.js"), reply);
    expect(record.status).toBe(200);
    expect(record.contentType).toContain("text/javascript");
    expect(String(record.payload)).toBe(APP_JS);
  });

  it("rejects a sibling-prefix escape (<root>-backup) with 404", async () => {
    const hook = createConsoleServeHook({ distPath });
    const { reply, record } = mockReply();
    // `/console/../dist-backup/secret.txt` resolves to `<base>/dist-backup/...`,
    // which shares the `<base>/dist` prefix but is NOT under it.
    await hook(req("/console/../dist-backup/secret.txt"), reply);
    expect(record.status).toBe(404);
    expect(JSON.stringify(record.payload)).not.toContain(SECRET);
    const err = (record.payload as { error: { code: string; requestId: string } }).error;
    expect(err.code).toBe("not_found");
    // The hand-built 404 must be a full ErrorEnvelope — requestId included.
    expect(err.requestId).toBe("req-test");
  });

  it("leaves non-console paths untouched", async () => {
    const hook = createConsoleServeHook({ distPath });
    const { reply, record } = mockReply();
    await hook(req("/v1/sessions"), reply);
    // Hook returned without sending — auth + route handlers proceed.
    expect(record.payload).toBeUndefined();
    expect(record.status).toBe(200);
    // No console headers leak onto non-console responses from this hook.
    expect(record.headers).toEqual({});
  });

  it("stamps the console security headers (console spec §3.4) on 200s and 404s alike", async () => {
    const hook = createConsoleServeHook({ distPath });
    for (const url of ["/console/app.js", "/console/../dist-backup/secret.txt"]) {
      const { reply, record } = mockReply();
      await hook(req(url), reply);
      expect(record.headers["Content-Security-Policy"]).toBe(
        "default-src 'self'; frame-ancestors 'none'",
      );
      expect(record.headers["X-Content-Type-Options"]).toBe("nosniff");
      expect(record.headers["Referrer-Policy"]).toBe("no-referrer");
    }
  });
});
