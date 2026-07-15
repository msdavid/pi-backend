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
  record: { status: number; contentType?: string; payload: unknown };
} {
  const record: { status: number; contentType?: string; payload: unknown } = {
    status: 200,
    payload: undefined,
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
    send(payload: unknown) {
      record.payload = payload;
      return this;
    },
  } as unknown as FastifyReply;
  return { reply, record };
}

function req(url: string): FastifyRequest {
  return { url } as FastifyRequest;
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
    expect((record.payload as { error: { code: string } }).error.code).toBe("not_found");
  });

  it("leaves non-console paths untouched", async () => {
    const hook = createConsoleServeHook({ distPath });
    const { reply, record } = mockReply();
    await hook(req("/v1/sessions"), reply);
    // Hook returned without sending — auth + route handlers proceed.
    expect(record.payload).toBeUndefined();
    expect(record.status).toBe(200);
  });
});
