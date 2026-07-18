// @vitest-environment node
/**
 * Cookie-session contract tests (console-spec §4) — the console API client
 * against the REAL in-process backend, real global `fetch`, real Postgres.
 *
 * These originally self-skipped while WP-C1.2 built the `/console/session`
 * endpoints concurrently; the endpoints are served now, so the suite runs
 * unconditionally (un-skipped by WP-C1.8, whose phase-1 gate enforces it).
 *
 * Run with `PI_REQUIRE_INTEGRATION=containers` so a missing container
 * runtime fails instead of silently skipping.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent, ConsoleSessionCreateResponse } from "@pi-managed/contracts";
import { ConsoleApiClient, ConsoleApiError } from "../client.js";
import {
  createConsoleSession,
  deleteConsoleSession,
  fetchConsoleSession,
} from "../console.js";
import { listSessions } from "../sessions.js";
import {
  requireContainers,
  startTestBackend,
  type TestBackend,
} from "./harness.js";

const RUNTIME = requireContainers("console-session cookie-flow contract suite");

describe.skipIf(!RUNTIME)("console session cookie flow ↔ real backend", () => {
  let backend: TestBackend;
  /** Client riding the console-session cookie (init override, real fetch). */
  let cookieClient: ConsoleApiClient;
  let cookie = "";

  beforeAll(async () => {
    backend = await startTestBackend();
  }, 120_000);

  afterAll(async () => {
    if (backend) await backend.stop();
  }, 120_000);

  it("POST /console/session → scopes + tenant, sets an HttpOnly cookie (§4.2)", async () => {
    const res = await new ConsoleApiClient({
      baseUrl: backend.baseUrl,
    }).request("POST", "/console/session", {
      body: { apiKey: backend.adminKey },
    });
    const body = ConsoleSessionCreateResponse.parse(await res.json());
    expect(body.tenant.id).toBe(backend.tenantId);
    expect(body.scopes).toContain("admin");

    const setCookie = res.headers
      .getSetCookie()
      .find((c) => /httponly/i.test(c));
    expect(setCookie).toBeTruthy();
    cookie = setCookie!.split(";")[0]!;
    cookieClient = new ConsoleApiClient({
      baseUrl: backend.baseUrl,
      headers: { Cookie: cookie },
    });
  });

  it("cookie-only /v1 read succeeds (§4.3)", async () => {
    const page = await listSessions({}, cookieClient);
    expect(page.nextCursor).toBeNull();
    expect(Array.isArray(page.data)).toBe(true);
  });

  it("GET /console/session → scopes + tenant + expiresAt (§4.4)", async () => {
    const info = await fetchConsoleSession(cookieClient);
    expect(info.tenant.id).toBe(backend.tenantId);
    expect(new Date(info.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("cookie mutation succeeds — the client's X-Console-Csrf header satisfies §4.5", async () => {
    const agent = await cookieClient.post(
      "/v1/agents",
      {
        name: "cookie-csrf-agent",
        model: { provider: "anthropic", id: "claude-sonnet-4" },
      },
      Agent,
    );
    expect(agent.name).toBe("cookie-csrf-agent");
  });

  it("cookie mutation WITHOUT the header → 403 (server enforces §4.5)", async () => {
    const res = await fetch(`${backend.baseUrl}/v1/agents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        name: "csrf-missing-agent",
        model: { provider: "anthropic", id: "claude-sonnet-4" },
      }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("invalid key → 401 error envelope through the client", async () => {
    const anon = new ConsoleApiClient({ baseUrl: backend.baseUrl });
    const err: unknown = await createConsoleSession(
      { apiKey: "pi_not_a_real_key" },
      anon,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConsoleApiError);
    const apiErr = err as ConsoleApiError;
    expect(apiErr.status).toBe(401);
    expect(apiErr.code).toBe("unauthorized");
    expect(apiErr.requestId).toBeTruthy();
  });

  it("DELETE /console/session signs out; the next GET is 401 (§4.4)", async () => {
    await deleteConsoleSession(cookieClient);
    const err: unknown = await fetchConsoleSession(cookieClient).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConsoleApiError);
    expect((err as ConsoleApiError).status).toBe(401);
  });
});
