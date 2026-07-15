import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { healthRoutes, DEFAULT_READINESS_CHECKS, type ReadinessCheck } from "./health.js";

async function build(checks: ReadinessCheck[] = DEFAULT_READINESS_CHECKS) {
  const app = Fastify();
  await app.register(healthRoutes, { readinessChecks: checks });
  return app;
}

describe("GET /healthz", () => {
  it("returns 200 {status:'ok'}", async () => {
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });
});

describe("GET /readyz", () => {
  it("returns 503 with all-down checks when no real probes registered (P0.1 default)", async () => {
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe("not_ready");
    const checks = body.checks as Record<string, { status: string; detail?: string }>;
    expect(checks.db.status).toBe("down");
    expect(checks.objectStore.status).toBe("down");
    expect(checks.sandbox.status).toBe("down");
    await app.close();
  });

  it("returns 200 when all checks are up", async () => {
    const allUp: ReadinessCheck[] = [
      { name: "db", check: async () => ({ status: "up" }) },
      { name: "objectStore", check: async () => ({ status: "up" }) },
      { name: "sandbox", check: async () => ({ status: "up" }) },
    ];
    const app = await build(allUp);
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ready");
    await app.close();
  });

  it("returns 503 when any check is down", async () => {
    const mixed: ReadinessCheck[] = [
      { name: "db", check: async () => ({ status: "up" }) },
      { name: "objectStore", check: async () => ({ status: "down", detail: "offline" }) },
      { name: "sandbox", check: async () => ({ status: "up" }) },
    ];
    const app = await build(mixed);
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe("not_ready");
    expect(body.checks.objectStore.status).toBe("down");
    expect(body.checks.objectStore.detail).toBe("offline");
    await app.close();
  });

  it("treats a throwing probe as down", async () => {
    const throwing: ReadinessCheck[] = [
      { name: "db", check: async () => { throw new Error("boom"); } },
    ];
    const app = await build(throwing);
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.checks.db.status).toBe("down");
    expect(body.checks.db.detail).toContain("boom");
    await app.close();
  });
});
