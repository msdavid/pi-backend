import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { apiClient } from "./app.js";

const pkgRoot = resolve(import.meta.dirname, "..");

/** Minimal fetch double that records calls and returns a fixed JSON body. */
function mockFetch(response, { status = 200 } = {}) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => response,
      text: async () => JSON.stringify(response),
    };
  };
  return { f, calls };
}

describe("apiClient — endpoints + auth", () => {
  const base = "https://host.example";

  it("listSessions → GET /v1/sessions with Bearer + filters + cursor", async () => {
    const { f, calls } = mockFetch({ data: [], nextCursor: null });
    const c = apiClient({ baseUrl: base, apiKey: "pmb_live_x", fetchImpl: f });
    await c.listSessions({ status: "idle", limit: 10, cursor: "abc" });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.init.method).toBe("GET");
    expect(call.init.headers.Authorization).toBe("Bearer pmb_live_x");
    expect(call.init.headers.Accept).toBe("application/json");
    const u = new URL(call.url);
    expect(u.origin).toBe("https://host.example");
    expect(u.pathname).toBe("/v1/sessions");
    expect(u.searchParams.get("status")).toBe("idle");
    expect(u.searchParams.get("limit")).toBe("10");
    expect(u.searchParams.get("cursor")).toBe("abc");
  });

  it("getSession → GET /v1/sessions/:id (id encoded)", async () => {
    const { f, calls } = mockFetch({ id: "sess_1" });
    const c = apiClient({ baseUrl: base, apiKey: "k", fetchImpl: f });
    await c.getSession("sess_01J/weird");
    expect(new URL(calls[0].url).pathname).toBe("/v1/sessions/sess_01J%2Fweird");
  });

  it("getEntries → GET /v1/sessions/:id/entries with from/to/limit", async () => {
    const { f, calls } = mockFetch({ data: [], nextCursor: null });
    const c = apiClient({ baseUrl: base, apiKey: "k", fetchImpl: f });
    await c.getEntries("sess_1", { from: 0, to: 50, limit: 100 });
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe("/v1/sessions/sess_1/entries");
    expect(u.searchParams.get("from")).toBe("0");
    expect(u.searchParams.get("to")).toBe("50");
    expect(u.searchParams.get("limit")).toBe("100");
  });

  it("getUsage → GET /v1/sessions/:id/usage", async () => {
    const { f, calls } = mockFetch({ inputTokens: 1, outputTokens: 2, usdCost: 0.01 });
    const c = apiClient({ baseUrl: base, apiKey: "k", fetchImpl: f });
    await c.getUsage("sess_1");
    expect(new URL(calls[0].url).pathname).toBe("/v1/sessions/sess_1/usage");
  });

  it("omits empty query params and strips trailing slash on baseUrl", async () => {
    const { f, calls } = mockFetch({ data: [], nextCursor: null });
    const c = apiClient({ baseUrl: "https://host.example/", apiKey: "k", fetchImpl: f });
    await c.listSessions();
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe("/v1/sessions");
    expect(u.search).toBe("");
  });

  it("throws on non-2xx carrying the status + body", async () => {
    const { f } = mockFetch({ error: { code: "unauthorized" } }, { status: 401 });
    const c = apiClient({ baseUrl: base, apiKey: "bad", fetchImpl: f });
    await expect(c.listSessions()).rejects.toMatchObject({ status: 401 });
  });
});

describe("console build", () => {
  it("produces dist/ with index.html, app.js, styles.css", () => {
    execSync("node scripts/build.mjs", { cwd: pkgRoot, stdio: "pipe" });
    const dist = resolve(pkgRoot, "dist");
    expect(existsSync(resolve(dist, "index.html"))).toBe(true);
    expect(existsSync(resolve(dist, "app.js"))).toBe(true);
    expect(existsSync(resolve(dist, "styles.css"))).toBe(true);
  });

  it("index.html loads app.js + styles.css (assets the backend serves at /console)", () => {
    const html = readFileSync(resolve(pkgRoot, "dist/index.html"), "utf8");
    expect(html).toContain('<script type="module" src="app.js">');
    expect(html).toContain('href="styles.css"');
  });

  it("app.js references the read-only v1 endpoints (no mutating calls)", () => {
    const js = readFileSync(resolve(pkgRoot, "dist/app.js"), "utf8");
    expect(js).toContain("/v1/sessions");
    expect(js).toContain("/v1/sessions/${encodeURIComponent(id)}");
    expect(js).toContain("/entries");
    expect(js).toContain("/usage");
    // Read-only: no mutating verbs are issued by the client.
    expect(js).not.toMatch(/method:\s*["']POST["']/);
    expect(js).not.toMatch(/method:\s*["']PATCH["']/);
    expect(js).not.toMatch(/method:\s*["']DELETE["']/);
  });
});
