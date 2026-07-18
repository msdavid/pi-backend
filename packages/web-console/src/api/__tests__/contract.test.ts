// @vitest-environment node
/**
 * Contract tests: the console API client against the REAL in-process backend
 * (WP-C1.5 acceptance; CONVENTIONS.md "Fakes at the seam" — the client↔server
 * boundary is the subject, so both sides are real: real Postgres
 * (testcontainer), real Fastify app on an ephemeral port, real global
 * `fetch`).
 *
 * Covers the WP-C1.1 surface that exists today: `GET /console/config`,
 * bearer-authed `/v1/sessions` reads + cursor pagination, list filters
 * observed as server-side result-set narrowing (not just the URL the client
 * builds — the enshrined-bug class), error-envelope parsing on forced real
 * 401/404 responses, and CSRF/Idempotency-Key header presence on mutations
 * (observed via a server-side echo route). The cookie-session flow (WP-C1.2
 * endpoints) lives in `console-session.contract.test.ts`.
 *
 * Run with `PI_REQUIRE_INTEGRATION=containers` so a missing container
 * runtime fails instead of silently skipping.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent, Environment, Session } from "@pi-managed/contracts";
import { ConsoleApiClient, ConsoleApiError } from "../client.js";
import { fetchConsoleConfig } from "../console.js";
import {
  getSession,
  getSessionUsage,
  listSessions,
  listSessionEntries,
} from "../sessions.js";
import {
  requireContainers,
  startTestBackend,
  type TestBackend,
} from "./harness.js";

const RUNTIME = requireContainers("web-console API-client contract suite");

/** Well-formed but non-existent session id (ULID payload). */
const MISSING_SESSION_ID = "sess_01ARZ3NDEKTSV4RRFFQ69G5FAV";

describe.skipIf(!RUNTIME)("console API client ↔ real backend", () => {
  let backend: TestBackend;
  /** Bearer-authed client (admin scope) — an init override, not a transport fake. */
  let admin: ConsoleApiClient;
  /** Unauthenticated client. */
  let anon: ConsoleApiClient;

  beforeAll(async () => {
    backend = await startTestBackend();
    admin = new ConsoleApiClient({
      baseUrl: backend.baseUrl,
      headers: { Authorization: `Bearer ${backend.adminKey}` },
    });
    anon = new ConsoleApiClient({ baseUrl: backend.baseUrl });
  }, 120_000);

  afterAll(async () => {
    if (backend) await backend.stop();
  }, 120_000);

  it("GET /console/config → exactly the two contract fields", async () => {
    const config = await fetchConsoleConfig(anon);
    expect(config).toEqual({ mode: "solo", onboardingEnabled: false });
  });

  it("empty sessions list → { data: [], nextCursor: null }", async () => {
    const page = await listSessions({}, admin);
    expect(page).toEqual({ data: [], nextCursor: null });
  });

  it("paginates /v1/sessions with the opaque cursor convention", async () => {
    // Seed through the client itself: agent + environment + 3 sessions —
    // exercising POST (schema-validated responses) on the real wire.
    const agent = await admin.post(
      "/v1/agents",
      {
        name: "console-contract-agent",
        model: { provider: "anthropic", id: "claude-sonnet-4" },
      },
      Agent,
    );
    const env = await admin.post(
      "/v1/environments",
      { name: "console-contract-env", type: "cloud" },
      Environment,
    );
    const created: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const session = await admin.post(
        "/v1/sessions",
        { agent: agent.id, environmentId: env.id },
        Session,
      );
      created.push(session.id);
    }

    const first = await listSessions({ limit: 2 }, admin);
    expect(first.data).toHaveLength(2);
    expect(typeof first.nextCursor).toBe("string");

    const second = await listSessions(
      { limit: 2, cursor: first.nextCursor! },
      admin,
    );
    expect(second.data).toHaveLength(1);
    expect(second.nextCursor).toBeNull();

    const seen = [...first.data, ...second.data].map((s) => s.id).sort();
    expect(seen).toEqual([...created].sort());
  });

  it("session detail + usage parse with the contracts schemas", async () => {
    const page = await listSessions({ limit: 1 }, admin);
    const id = page.data[0]!.id;

    const session = await getSession(id, admin);
    expect(session.id).toBe(id);
    expect(session.status).toBe("idle");

    const usage = await getSessionUsage(id, admin);
    expect(usage.usdCost).toBe(0);
    expect(usage.inputTokens).toBe(0);
  });

  it("entries: positional slice parses (empty — no JSONL written yet)", async () => {
    const page = await listSessions({ limit: 1 }, admin);
    const entries = await listSessionEntries(
      page.data[0]!.id,
      { from: 0, limit: 10 },
      admin,
    );
    expect(entries).toEqual({ data: [], nextCursor: null });
  });

  it("list filters narrow the RESULT SET server-side (status/agentId/environmentId)", async () => {
    // Seed sessions that differ in agent and environment; the assertions
    // are on what the server returns, not on the URL the client built.
    const agentA = await admin.post(
      "/v1/agents",
      {
        name: "console-filter-agent-a",
        model: { provider: "anthropic", id: "claude-sonnet-4" },
      },
      Agent,
    );
    const agentB = await admin.post(
      "/v1/agents",
      {
        name: "console-filter-agent-b",
        model: { provider: "anthropic", id: "claude-sonnet-4" },
      },
      Agent,
    );
    const envA = await admin.post(
      "/v1/environments",
      { name: "console-filter-env-a", type: "cloud" },
      Environment,
    );
    const envB = await admin.post(
      "/v1/environments",
      { name: "console-filter-env-b", type: "cloud" },
      Environment,
    );
    const sAA = await admin.post(
      "/v1/sessions",
      { agent: agentA.id, environmentId: envA.id },
      Session,
    );
    const sBA = await admin.post(
      "/v1/sessions",
      { agent: agentB.id, environmentId: envA.id },
      Session,
    );
    const sAB = await admin.post(
      "/v1/sessions",
      { agent: agentA.id, environmentId: envB.id },
      Session,
    );

    const byAgent = await listSessions({ agentId: agentB.id }, admin);
    expect(byAgent.data.map((s) => s.id)).toEqual([sBA.id]);

    const byEnv = await listSessions({ environmentId: envB.id }, admin);
    expect(byEnv.data.map((s) => s.id)).toEqual([sAB.id]);

    const combined = await listSessions(
      { agentId: agentA.id, environmentId: envA.id },
      admin,
    );
    expect(combined.data.map((s) => s.id)).toEqual([sAA.id]);

    // Status: everything just created is idle, so `running` must exclude
    // all of it while `idle` returns it — the server applied the filter.
    const idle = await listSessions(
      { status: "idle", agentId: agentA.id },
      admin,
    );
    expect(idle.data.map((s) => s.id).sort()).toEqual([sAA.id, sAB.id].sort());
    const running = await listSessions(
      { status: "running", agentId: agentA.id },
      admin,
    );
    expect(running.data).toEqual([]);
  });

  it("real 404 → ConsoleApiError with status/code/requestId (DP-9 data)", async () => {
    const err: unknown = await getSession(MISSING_SESSION_ID, admin).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConsoleApiError);
    const apiErr = err as ConsoleApiError;
    expect(apiErr.status).toBe(404);
    expect(apiErr.code).toBe("not_found");
    expect(apiErr.requestId).toBeTruthy();
    expect(apiErr.message).toContain(MISSING_SESSION_ID);
  });

  it("real 401 → ConsoleApiError with unauthorized code", async () => {
    const err: unknown = await listSessions({}, anon).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConsoleApiError);
    const apiErr = err as ConsoleApiError;
    expect(apiErr.status).toBe(401);
    expect(apiErr.code).toBe("unauthorized");
    expect(apiErr.requestId).toBeTruthy();
  });

  it("mutations carry X-Console-Csrf: 1 + an Idempotency-Key; GETs do not", async () => {
    const echo = async (method: "GET" | "POST" | "DELETE") => {
      const res = await admin.request(method, "/v1/__test-echo-headers", {
        ...(method === "POST" ? { body: {} } : {}),
      });
      const { headers } = (await res.json()) as {
        headers: Record<string, string | undefined>;
      };
      return headers;
    };

    const posted = await echo("POST");
    expect(posted["x-console-csrf"]).toBe("1");
    expect(posted["idempotency-key"]).toBeTruthy();

    const deleted = await echo("DELETE");
    expect(deleted["x-console-csrf"]).toBe("1");

    const got = await echo("GET");
    expect(got["x-console-csrf"]).toBeUndefined();
  });
});
