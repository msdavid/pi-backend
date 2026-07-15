import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import pino from "pino";
import { createApp, type CreateAppOptions } from "./server.js";
import { ApiError } from "./domain/errors.js";
import type { Config } from "./infra/config/index.js";
import { DEFAULT_READINESS_CHECKS } from "./api/health.js";

const silentLogger = pino({ level: "silent" });

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 3000,
    logLevel: "info",
    objectStoreRoot: "./data/objectstore",
    sandboxRuntime: "disabled",
    ...overrides,
  } as Config;
}

async function makeApp(opts?: Partial<CreateAppOptions>) {
  const app = await createApp({
    config: testConfig(),
    logger: silentLogger,
    readinessChecks: opts?.readinessChecks ?? DEFAULT_READINESS_CHECKS,
  });
  return app;
}

describe("createApp", () => {
  it("wires /healthz green", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("wires /readyz red (503) by default", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe("not_ready");
    await app.close();
  });

  it("sets security response headers on every response (SEC-12)", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(String(res.headers["content-security-policy"])).toContain("default-src 'self'");
    expect(String(res.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
    await app.close();
  });

  it("maps ApiError to ErrorEnvelope", async () => {
    const app = await makeApp();
    app.get("/throw", async () => {
      throw new ApiError(409, "conflict", "already exists", { id: "x" });
    });
    const res = await app.inject({ method: "GET", url: "/throw" });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe("conflict");
    expect(body.error.message).toBe("already exists");
    expect(body.error.details).toEqual({ id: "x" });
    expect(body.error.requestId).toEqual(expect.any(String));
    await app.close();
  });

  it("maps unknown errors to internal_error (500)", async () => {
    const app = await makeApp();
    app.get("/boom", async () => {
      throw new Error("kaboom");
    });
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error.code).toBe("internal_error");
    expect(body.error.requestId).toEqual(expect.any(String));
    await app.close();
  });

  it("returns ErrorEnvelope 404 for unknown routes", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
    await app.close();
  });
});

describe("createApp is a plain Fastify factory (usable standalone)", () => {
  it("returns a Fastify instance", async () => {
    const app = await makeApp();
    expect(typeof app.inject).toBe("function");
    expect(typeof app.close).toBe("function");
    await app.close();
    // Silence unused import lint for Fastify default (sanity re-export check).
    void Fastify;
  });
});
