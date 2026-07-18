// @vitest-environment node
/**
 * Phase-1 gate — console-spec §13 items §3.4 (live half) and §4.5, against
 * the REAL backend: testcontainers Postgres, the real Fastify app serving
 * this package's built `dist/`, real global `fetch` (CONVENTIONS.md, "Fakes
 * at the seam" — both sides of the boundary are real).
 *
 * §3.4: every `/console*` response — the SPA index, history-API fallbacks,
 * hashed assets, `GET /console/config`, asset 404s, and the session
 * endpoints' errors — carries the pinned CSP, nosniff, and no-referrer
 * headers.
 *
 * §4.5: a cookie-authenticated mutation WITHOUT `X-Console-Csrf: 1` is
 * rejected 403 (`forbidden` envelope); the same request with the header is
 * the positive control. The sign-in response's `HttpOnly` cookie is also
 * asserted here — the server half of §4.1 (the cookie is invisible to JS).
 *
 * Run with `PI_REQUIRE_INTEGRATION=containers` so a missing container
 * runtime fails instead of silently skipping.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  requireContainers,
  startTestBackend,
  type TestBackend,
} from "../../src/api/__tests__/harness.js";
import { distDir, ensureConsoleDist } from "./helpers.js";

const RUNTIME = requireContainers("phase-1 gate: /console* headers + CSRF");

/** The exact §3.4 header set (pinned in `packages/backend/src/api/console.ts`). */
function expectSecurityHeaders(res: Response, url: string) {
  expect(
    res.headers.get("content-security-policy"),
    `CSP on ${url}`,
  ).toBe("default-src 'self'; frame-ancestors 'none'");
  expect(
    res.headers.get("x-content-type-options"),
    `nosniff on ${url}`,
  ).toBe("nosniff");
  expect(
    res.headers.get("referrer-policy"),
    `referrer-policy on ${url}`,
  ).toBe("no-referrer");
}

describe.skipIf(!RUNTIME)("§3.4 + §4.5 — real backend over built dist/", () => {
  let backend: TestBackend;
  /** A hashed asset URL read off the built index.html (what a browser loads). */
  let assetUrl: string;

  beforeAll(async () => {
    ensureConsoleDist();
    const html = readFileSync(join(distDir, "index.html"), "utf8");
    assetUrl = /src="(\/console\/assets\/[^"]+)"/.exec(html)![1]!;
    backend = await startTestBackend();
  }, 150_000);

  afterAll(async () => {
    if (backend) await backend.stop();
  }, 120_000);

  it("every /console* response shape carries the §3.4 headers", async () => {
    const cases: { url: string; status: number }[] = [
      { url: "/console/", status: 200 }, // SPA index
      { url: "/console/sessions/sess_01GATEFAKE", status: 200 }, // history fallback
      { url: "/console/config", status: 200 }, // config endpoint
      { url: assetUrl, status: 200 }, // hashed asset
      // A missing asset also serves the SPA fallback (the hook 404s only
      // when dist/ was never built — header coverage for that shape lives in
      // packages/backend/src/api/console.test.ts).
      { url: "/console/missing-asset.js", status: 200 },
      { url: "/console/session", status: 401 }, // session endpoint error
    ];
    for (const { url, status } of cases) {
      const res = await fetch(`${backend.baseUrl}${url}`);
      expect(res.status, `status of ${url}`).toBe(status);
      expectSecurityHeaders(res, url);
    }
  });

  it("history-API fallback serves the SPA index for client routes", async () => {
    const res = await fetch(
      `${backend.baseUrl}/console/sessions/sess_01GATEFAKE`,
    );
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain('<div id="root">');
  });

  it("§4.5 — cookie mutation without X-Console-Csrf → 403; with it → 201 (and the cookie is HttpOnly, §4.1 server half)", async () => {
    // Sign in (the login POST itself is CSRF-exempt, §4.5).
    const signIn = await fetch(`${backend.baseUrl}/console/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: backend.adminKey }),
    });
    expect(signIn.status).toBe(201);
    expectSecurityHeaders(signIn, "/console/session (POST)");
    const setCookie = signIn.headers
      .getSetCookie()
      .find((c) => c.startsWith("pi_console_session="));
    expect(setCookie).toBeTruthy();
    expect(setCookie!).toMatch(/httponly/i); // §4.1: invisible to JS
    const cookie = setCookie!.split(";")[0]!;

    // Cookie-authed mutation WITHOUT the CSRF header → 403 forbidden.
    const makeAgent = (headers: Record<string, string>) =>
      fetch(`${backend.baseUrl}/v1/agents`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          "Idempotency-Key": crypto.randomUUID(),
          ...headers,
        },
        body: JSON.stringify({
          name: `gate-csrf-agent-${crypto.randomUUID().slice(0, 8)}`,
          model: { provider: "anthropic", id: "claude-sonnet-4" },
        }),
      });

    const rejected = await makeAgent({});
    expect(rejected.status).toBe(403);
    const envelope = (await rejected.json()) as { error: { code: string } };
    expect(envelope.error.code).toBe("forbidden");

    // Positive control: the identical request WITH the header succeeds.
    const accepted = await makeAgent({ "X-Console-Csrf": "1" });
    expect(accepted.status).toBe(201);
  });
});
