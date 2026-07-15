import { describe, it, expect, beforeAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConsoleServeHook } from "./console.js";

/**
 * WP-4.5 smoke test: the console serve hook serves the built SPA at `/console`
 * and bypasses a preceding auth hook, while non-console routes still require
 * auth. Uses a tmp asset dir (no dependency on the real web-console build).
 */
describe("web console serve hook (WP-4.5)", () => {
  let app: FastifyInstance;
  const dist = mkdtempSync(join(tmpdir(), "pi-console-"));
  const html = "<!doctype html><html><body>console</body></html>";

  beforeAll(async () => {
    writeFileSync(join(dist, "index.html"), html);
    writeFileSync(join(dist, "app.js"), "export const x = 1;");
    writeFileSync(join(dist, "styles.css"), "body{color:red}");

    app = Fastify({ logger: false });
    // Console hook FIRST (as server.ts registers it before auth).
    app.addHook("onRequest", createConsoleServeHook({ distPath: dist }));
    // A stand-in auth hook that mirrors api/middleware/auth.ts: it 401s every
    // request without a Bearer token. It has NO /console carve-out — the only
    // thing sparing console paths from 401 is the console hook's send() short-
    // circuit running first (exactly as server.ts orders them).
    app.addHook("onRequest", async (req, reply) => {
      const h = req.headers.authorization;
      if (!h || !h.startsWith("Bearer ")) {
        return reply.code(401).send({ error: { code: "unauthorized" } });
      }
    });
    app.get("/v1/sessions", async () => ({ data: [], nextCursor: null }));
  });

  it("serves /console as text/html without auth", async () => {
    const res = await app.inject({ method: "GET", url: "/console" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toBe(html);
  });

  it("serves /console/ and sub-assets (app.js, styles.css) without auth", async () => {
    const js = await app.inject({ method: "GET", url: "/console/app.js" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toContain("javascript");
    const css = await app.inject({ method: "GET", url: "/console/styles.css" });
    expect(css.statusCode).toBe(200);
    expect(css.headers["content-type"]).toContain("text/css");
  });

  it("falls back to index.html for unknown console sub-paths (SPA routing)", async () => {
    const res = await app.inject({ method: "GET", url: "/console/some/deep/route" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toBe(html);
  });

  it("blocks path traversal outside the asset root", async () => {
    // Fastify normalizes `/console/../…` to `/etc/passwd` before the hook runs,
    // so it never matches the console prefix → auth 401 (or 404/200 if it had).
    // Either way, no file outside dist is ever served.
    const res = await app.inject({ method: "GET", url: "/console/../../../../etc/passwd" });
    expect([200, 404, 401]).toContain(res.statusCode);
    expect(res.body).not.toContain("root:");
  });

  it("still requires auth on non-console /v1 routes", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/sessions" });
    expect(res.statusCode).toBe(401);
  });
});
