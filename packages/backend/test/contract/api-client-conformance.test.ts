/**
 * R3.2 — client ↔ server contract conformance suite (owns the seam).
 *
 * The SSE 404 (R3.1) shipped because `api-client.test.ts` stubs `fetch` and asserts on
 * the URL the client itself produced: a test that can never disagree with the client.
 * This suite is the opposite. It drives the **real** `ManagedApiClient`
 * (`packages/client-extension/src/api-client.ts`) against the **real** in-process
 * Fastify app booted by the real composition root (`createManagedApp`) on a real port,
 * over a real Postgres (testcontainers/podman). Nothing on the wire is faked: path,
 * method, `Authorization` header, request body, status code and response shape are all
 * produced and consumed by production code.
 *
 * What it proves, table-driven over EVERY public method of `ManagedApiClient`:
 *   1. the request the client emits hits a route that EXISTS (a Fastify
 *      `route not found` 404 fails the case — this is the R3.1 detector),
 *   2. the status is the documented one (2xx, or the documented error),
 *   3. the response body parses against the `@pi-managed/contracts` schema the client
 *      claims to return.
 * A coverage guard reflects over `ManagedApiClient.prototype` and fails if a public
 * method has no table row — so a method added tomorrow cannot ship untested.
 *
 * SSE (§9.3, R3.1): `streamSession` must connect to the canonical
 * `/v1/sessions/:id/stream` and receive frames; the polling fallback
 * (`GET /v1/sessions/:id/events`, §24.10) is exercised by making the SSE transport
 * fail while every other request still goes to the real backend.
 *
 * ── Layout (pnpm workspace) ────────────────────────────────────────────────────
 * The suite lives in the **backend** package because that is the side that owns the
 * heavy harness (testcontainers Postgres, migrations, the composition root, the vitest
 * `test/**` glob and `ALLOW_EPHEMERAL_VAULT_KEY`), and it therefore runs inside
 * `pnpm -r test` with no new package or script. It imports the client by **relative
 * path into `packages/client-extension/src`**, deliberately:
 *   - `@pi-managed/client` resolves to `dist/`, so a package-name import would test a
 *     BUILT artifact (possibly stale) rather than the source under review — exactly the
 *     kind of gap this WP exists to close; and it would require a new workspace
 *     dependency + lockfile churn.
 *   - the client's only imports are `node:crypto` and *type-only* imports from
 *     `@pi-managed/contracts`, so importing its source pulls in no runtime dependency
 *     the backend package does not already have.
 * Vitest resolves the `.js` specifier to the `.ts` source; `tsc` never sees this file
 * (backend `tsconfig.json` includes only `src`), so no `rootDir` violation is possible.
 *
 * Skips cleanly when no container runtime is available (keeps `pnpm test` green in dev).
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pino from "pino";
import {
  Agent,
  Credential,
  Cursor,
  Job,
  JobRun,
  JobRunTriggerResponse,
  Memory,
  MemoryStore,
  MemorySummary,
  MemoryVersion,
  Session,
  SessionUsageResponse,
  TenantInfo,
  Vault,
} from "@pi-managed/contracts";
import { FakeSandboxProvider } from "@pi-managed/testkit";
import { createManagedApp, type ManagedApp } from "../../src/app.js";
import { loadConfig } from "../../src/infra/config/index.js";
import {
  hasContainerRuntime,
  startPostgres,
  type TestDb,
} from "../../src/infra/db/__tests__/test-runtime.js";
import { FakeAgentSessionFactory } from "../../src/domain/session-manager/__tests__/fake-agent-session.js";
import { createTenant } from "../../src/domain/tenant/tenant.js";
import { issueApiKey } from "../../src/domain/tenant/api-key.js";
import { createEnvironment } from "../../src/domain/environment/environment.js";
import type { TenantCtx } from "../../src/infra/db/index.js";
// The subject of the seam — imported from SOURCE (see the layout note above).
import {
  ManagedApiClient,
  ApiClientError,
  type FetchImpl,
  type ParsedSseFrame,
} from "../../../client-extension/src/api-client.js";

const RUN = hasContainerRuntime();
const d = RUN ? describe : describe.skip;

/** A 32-byte hex vault key so vault credentials encrypt deterministically. */
process.env.VAULT_KEY = "0".repeat(64);

// ---------------------------------------------------------------------------
// Wire recorder — the only thing wrapped around `fetch`. It does not *answer*
// requests (the real server does); it observes them, so each case can assert
// "this method hit a real route with a real status".
// ---------------------------------------------------------------------------

interface WireCall {
  method: string;
  path: string;
  status: number;
  /** True when Fastify's notFound handler answered → the route does not exist. */
  routeMissing: boolean;
  authorization: string | undefined;
}

const wire: WireCall[] = [];

/** Last observed request (the one the case under test just made). */
function lastCall(): WireCall {
  const call = wire.at(-1);
  if (!call) throw new Error("no HTTP request was made");
  return call;
}

function headerOf(input: RequestInfo | URL, init: RequestInit | undefined, name: string) {
  const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  return h.get(name) ?? undefined;
}

/**
 * A recording `fetch`. `breakSse: true` makes only the SSE request fail at the
 * transport level (as a proxy/LB dropping `text/event-stream` would) — every other
 * request still reaches the real server, so the polling fallback is exercised against
 * the real `GET /v1/sessions/:id/events`.
 */
function recordingFetch(opts: { breakSse?: boolean } = {}): FetchImpl {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const path = new URL(url).pathname;
    const authorization = headerOf(input, init, "authorization");

    if (opts.breakSse && path.endsWith("/stream")) {
      wire.push({ method, path, status: 0, routeMissing: false, authorization });
      throw new TypeError("fetch failed: simulated SSE transport failure");
    }

    const res = await fetch(input as RequestInfo, init);
    let routeMissing = false;
    if (res.status === 404) {
      const body = await res.clone().text();
      routeMissing = /route not found/i.test(body);
    }
    wire.push({ method, path, status: res.status, routeMissing, authorization });
    return res;
  }) as FetchImpl;
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 15_000,
): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Fixtures produced by earlier ladder rows and consumed by later ones. */
interface Fixtures {
  agentId: string;
  environmentId: string;
  sessionId: string;
  /** A session that has been woken → has a live (fake) sandbox + persisted events. */
  warmSessionId: string;
  jobId: string;
  storeId: string;
  memoryPath: string;
  memorySha: string;
  vaultId: string;
  credentialKey: string;
  sandboxName: string;
  downloadPath: string;
}

/** One conformance case: a client method exercised against the live backend. */
interface Case {
  /** The `ManagedApiClient` method this row covers (drives the coverage guard). */
  method: string;
  /** Canonical route the request MUST land on (regex over the observed pathname). */
  path: RegExp;
  httpMethod: string;
  /** Documented status. */
  status: number;
  /** Invoke the client method; may stash fixtures for later rows. */
  run: (c: ManagedApiClient, fx: Fixtures) => Promise<unknown>;
  /** Assert the response shape (contracts schema). */
  check?: (result: unknown, fx: Fixtures) => void;
}

d("R3.2 contract conformance: ManagedApiClient ↔ real backend", () => {
  let db: TestDb;
  let managed: ManagedApp;
  let provider: FakeSandboxProvider;
  let client: ManagedApiClient;
  let baseUrl: string;
  let apiKey: string;
  let ctx: TenantCtx;
  const fx = {} as Fixtures;

  beforeAll(async () => {
    db = await startPostgres();
    const objectStoreRoot = mkdtempSync(join(tmpdir(), "pi-conformance-obj-"));
    fx.downloadPath = join(mkdtempSync(join(tmpdir(), "pi-conformance-dl-")), "hello.txt");

    const config = loadConfig({
      env: {
        DB_URL: db.connectionString,
        OBJECT_STORE_ROOT: objectStoreRoot,
        SANDBOX_RUNTIME: "disabled",
        LOG_LEVEL: "error",
        VAULT_KEY: "0".repeat(64),
      },
    });

    provider = new FakeSandboxProvider();
    managed = await createManagedApp({
      config,
      logger: pino({ level: "error" }),
      objectStoreConfig: { kind: "filesystem", root: objectStoreRoot },
      sandboxProvider: provider,
      factory: new FakeAgentSessionFactory(),
      // No background timers: this suite drives every code path through the client.
      schedulerIntervalMs: 0,
      revalidationIntervalMs: 0,
    });

    await managed.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = managed.app.server.address();
    if (!addr || typeof addr === "string") throw new Error("failed to bind");
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const tenant = await createTenant(managed.pool, { name: "conformance-tenant" });
    ctx = { tenantId: tenant.id };
    const issued = await issueApiKey(managed.pool, ctx, { name: "conformance-key" });
    apiKey = issued.key;

    // The client under test — real fetch, real bearer key, real backend.
    client = new ManagedApiClient({
      backendUrl: baseUrl,
      getApiKey: () => apiKey,
      fetchImpl: recordingFetch(),
      pollingIntervalMs: 50,
      streamTimeoutMs: 20_000,
    });

    // Environments have no client method (the extension never creates one), so the
    // fixture is made through the domain — everything else goes through the client.
    const env = await createEnvironment(managed.pool, ctx, {
      name: "conformance-env",
      type: "cloud",
    });
    fx.environmentId = env.id;
  }, 180_000);

  afterAll(async () => {
    await managed?.close().catch(() => {});
    await db?.container.stop().catch(() => {});
  });

  // -------------------------------------------------------------------------
  // The ladder. Order matters: rows create the fixtures later rows consume
  // (vitest runs `it`s in a file sequentially).
  // -------------------------------------------------------------------------
  const cases: Case[] = [
    {
      method: "getTenant",
      httpMethod: "GET",
      path: /^\/v1\/tenant$/,
      status: 200,
      run: (c) => c.getTenant(),
      check: (r) => {
        TenantInfo.parse(r);
      },
    },
    {
      method: "createAgent",
      httpMethod: "POST",
      path: /^\/v1\/agents$/,
      status: 201,
      run: async (c, f) => {
        const agent = await c.createAgent({
          name: "conformance-agent",
          model: { provider: "anthropic", id: "claude-sonnet-4-5" },
        });
        f.agentId = agent.id;
        return agent;
      },
      check: (r) => {
        Agent.parse(r);
      },
    },
    {
      method: "createSession",
      httpMethod: "POST",
      path: /^\/v1\/sessions$/,
      status: 201,
      run: async (c, f) => {
        const session = await c.createSession({
          agent: f.agentId,
          environmentId: f.environmentId,
          title: "conformance",
        });
        f.sessionId = session.id;
        return session;
      },
      check: (r) => {
        Session.parse(r);
      },
    },
    {
      method: "listSessions",
      httpMethod: "GET",
      path: /^\/v1\/sessions$/,
      status: 200,
      run: (c) => c.listSessions({ limit: 10, status: "idle" }),
      check: (r) => {
        expect(Cursor(Session).parse(r).data.length).toBeGreaterThan(0);
      },
    },
    {
      method: "getSession",
      httpMethod: "GET",
      path: /^\/v1\/sessions\/sess_[^/]+$/,
      status: 200,
      run: (c, f) => c.getSession(f.sessionId),
      check: (r, f) => {
        expect(Session.parse(r).id).toBe(f.sessionId);
      },
    },
    {
      method: "getSessionUsage",
      httpMethod: "GET",
      path: /^\/v1\/sessions\/sess_[^/]+\/usage$/,
      status: 200,
      run: (c, f) => c.getSessionUsage(f.sessionId),
      check: (r) => {
        SessionUsageResponse.parse(r);
      },
    },
    {
      method: "forkSession",
      httpMethod: "POST",
      path: /^\/v1\/sessions\/sess_[^/]+\/fork$/,
      status: 201,
      run: (c, f) => c.forkSession(f.sessionId),
      check: (r, f) => {
        expect(Session.parse(r).forkedFromSessionId).toBe(f.sessionId);
      },
    },
    {
      // §24.8 `remote_read_outputs` — the extension's only `fetchJson` call site
      // (client-extension/src/tools/remote-tools.ts).
      method: "fetchJson",
      httpMethod: "GET",
      path: /^\/v1\/sessions\/sess_[^/]+\/outputs$/,
      status: 200,
      run: (c, f) => {
        provider.scriptExec(f.sandboxName, [{ stdout: "hello.txt\n", exitCode: 0 }]);
        // The WARM session — it has a live sandbox (see the wake test above).
        return c.fetchJson<{ data: { name: string }[] }>(
          `/v1/sessions/${f.warmSessionId}/outputs`,
        );
      },
      check: (r) => {
        expect((r as { data: { name: string }[] }).data).toEqual([{ name: "hello.txt" }]);
      },
    },
    {
      method: "downloadFile",
      httpMethod: "GET",
      path: /^\/v1\/sessions\/sess_[^/]+\/outputs\/hello\.txt$/,
      status: 200,
      run: async (c, f) => {
        provider.scriptExec(f.sandboxName, [{ stdout: "hello world", exitCode: 0 }]);
        await c.downloadFile(
          `/v1/sessions/${f.warmSessionId}/outputs/hello.txt`,
          f.downloadPath,
        );
        return undefined;
      },
      check: (_r, f) => {
        expect(readFileSync(f.downloadPath, "utf8")).toBe("hello world");
      },
    },
    {
      method: "sendEvent",
      httpMethod: "POST",
      path: /^\/v1\/sessions\/sess_[^/]+\/events$/,
      status: 202,
      run: (c, f) => c.sendEvent(f.sessionId, { type: "user.message", content: "hi again" }),
    },
    {
      method: "createJob",
      httpMethod: "POST",
      path: /^\/v1\/jobs$/,
      status: 201,
      run: async (c, f) => {
        const job = await c.createJob({
          name: "conformance-job",
          agent: f.agentId,
          environmentId: f.environmentId,
          initialEvents: [{ type: "user.message", content: "go" }],
          schedule: { cron: "0 9 * * *", tz: "UTC" },
        });
        f.jobId = job.id;
        return job;
      },
      check: (r) => {
        Job.parse(r);
      },
    },
    {
      method: "listJobs",
      httpMethod: "GET",
      path: /^\/v1\/jobs$/,
      status: 200,
      run: (c) => c.listJobs({ limit: 10 }),
      check: (r) => {
        expect(Cursor(Job).parse(r).data.length).toBeGreaterThan(0);
      },
    },
    {
      method: "pauseJob",
      httpMethod: "POST",
      path: /^\/v1\/jobs\/job_[^/]+\/pause$/,
      status: 200,
      run: (c, f) => c.pauseJob(f.jobId),
      check: (r) => {
        expect(Job.parse(r).status).toBe("paused");
      },
    },
    {
      method: "unpauseJob",
      httpMethod: "POST",
      path: /^\/v1\/jobs\/job_[^/]+\/unpause$/,
      status: 200,
      run: (c, f) => c.unpauseJob(f.jobId),
      check: (r) => {
        expect(Job.parse(r).status).toBe("active");
      },
    },
    {
      method: "runJob",
      httpMethod: "POST",
      path: /^\/v1\/jobs\/job_[^/]+\/run$/,
      status: 202,
      run: (c, f) => c.runJob(f.jobId),
      check: (r) => {
        JobRunTriggerResponse.parse(r);
      },
    },
    {
      method: "listJobRuns",
      httpMethod: "GET",
      path: /^\/v1\/jobs\/job_[^/]+\/runs$/,
      status: 200,
      run: (c, f) => c.listJobRuns(f.jobId, { limit: 10 }),
      check: (r) => {
        expect(Cursor(JobRun).parse(r).data.length).toBeGreaterThan(0);
      },
    },
    {
      method: "archiveJob",
      httpMethod: "POST",
      path: /^\/v1\/jobs\/job_[^/]+\/archive$/,
      status: 200,
      run: (c, f) => c.archiveJob(f.jobId),
      check: (r) => {
        expect(Job.parse(r).status).toBe("archived");
      },
    },
    {
      method: "createMemoryStore",
      httpMethod: "POST",
      path: /^\/v1\/memory-stores$/,
      status: 201,
      run: async (c, f) => {
        const store = await c.createMemoryStore({ displayTitle: "Conformance notes" });
        f.storeId = store.id;
        return store;
      },
      check: (r) => {
        MemoryStore.parse(r);
      },
    },
    {
      method: "listMemoryStores",
      httpMethod: "GET",
      path: /^\/v1\/memory-stores$/,
      status: 200,
      run: (c) => c.listMemoryStores({ limit: 10 }),
      check: (r) => {
        expect(Cursor(MemoryStore).parse(r).data.length).toBeGreaterThan(0);
      },
    },
    {
      method: "createMemory",
      httpMethod: "POST",
      path: /^\/v1\/memory-stores\/mem_[^/]+\/memories$/,
      status: 201,
      run: async (c, f) => {
        f.memoryPath = "notes.md";
        const mem = await c.createMemory(f.storeId, {
          path: f.memoryPath,
          content: "first",
        });
        f.memorySha = mem.contentSha256;
        return mem;
      },
      check: (r) => {
        Memory.parse(r);
      },
    },
    {
      method: "listMemories",
      httpMethod: "GET",
      path: /^\/v1\/memory-stores\/mem_[^/]+\/memories$/,
      status: 200,
      run: (c, f) => c.listMemories(f.storeId, { limit: 10 }),
      check: (r) => {
        expect(Cursor(MemorySummary).parse(r).data.length).toBe(1);
      },
    },
    {
      method: "getMemory",
      httpMethod: "GET",
      path: /^\/v1\/memory-stores\/mem_[^/]+\/memories\/notes\.md$/,
      status: 200,
      run: (c, f) => c.getMemory(f.storeId, f.memoryPath),
      check: (r) => {
        expect(Memory.parse(r).content).toBe("first");
      },
    },
    {
      method: "updateMemory",
      httpMethod: "PATCH",
      path: /^\/v1\/memory-stores\/mem_[^/]+\/memories\/notes\.md$/,
      status: 200,
      run: (c, f) =>
        c.updateMemory(f.storeId, f.memoryPath, {
          content: "second",
          contentSha256: f.memorySha,
        }),
      check: (r) => {
        expect(Memory.parse(r).content).toBe("second");
      },
    },
    {
      method: "listMemoryVersions",
      httpMethod: "GET",
      path: /^\/v1\/memory-stores\/mem_[^/]+\/versions$/,
      status: 200,
      run: (c, f) => c.listMemoryVersions(f.storeId, { limit: 10 }),
      check: (r) => {
        expect(Cursor(MemoryVersion).parse(r).data.length).toBeGreaterThan(0);
      },
    },
    {
      method: "createVault",
      httpMethod: "POST",
      path: /^\/v1\/vaults$/,
      status: 201,
      run: async (c, f) => {
        const vault = await c.createVault({ name: "conformance-vault" });
        f.vaultId = vault.id;
        return vault;
      },
      check: (r) => {
        Vault.parse(r);
      },
    },
    {
      method: "listVaults",
      httpMethod: "GET",
      path: /^\/v1\/vaults$/,
      status: 200,
      run: (c) => c.listVaults({ limit: 10 }),
      check: (r) => {
        expect(Cursor(Vault).parse(r).data.length).toBeGreaterThan(0);
      },
    },
    {
      method: "addCredential",
      httpMethod: "POST",
      path: /^\/v1\/vaults\/vault_[^/]+\/credentials$/,
      status: 201,
      run: async (c, f) => {
        f.credentialKey = "GITHUB_TOKEN";
        return c.addCredential(f.vaultId, {
          key: f.credentialKey,
          category: "environment_variable",
          secretValue: "s3cret",
        });
      },
      check: (r) => {
        const cred = Credential.parse(r);
        // §25.5: the response must never carry the secret back.
        expect(JSON.stringify(cred)).not.toContain("s3cret");
      },
    },
    {
      method: "listCredentials",
      httpMethod: "GET",
      path: /^\/v1\/vaults\/vault_[^/]+\/credentials$/,
      status: 200,
      run: (c, f) => c.listCredentials(f.vaultId),
      check: (r) => {
        expect(Cursor(Credential).parse(r).data.length).toBe(1);
      },
    },
    {
      method: "validateCredential",
      httpMethod: "POST",
      path: /^\/v1\/vaults\/vault_[^/]+\/credentials\/GITHUB_TOKEN\/validate$/,
      status: 200,
      run: (c, f) => c.validateCredential(f.vaultId, f.credentialKey),
      check: (r) => {
        // FINDING R3.2-F1 (reported, NOT fixed here — the fix belongs to whoever owns
        // api-client.ts / contracts / api-reference.md, not to this suite):
        // the route sends `{ status: "valid"|"invalid"|"unknown" }` (api/vaults.ts),
        // while `contracts.CredentialValidateResponse` — the type the client method
        // declares as its return — is the BARE enum. The client hands callers an
        // object typed as a string. This assertion pins the observed wire shape, which
        // is what the client actually receives.
        expect(r).toEqual({ status: "unknown" });
        expect(typeof r).not.toBe("string");
      },
    },
  ];

  it("issues an authenticated request to a route that exists (smoke)", async () => {
    const info = await client.getTenant();
    expect(info.tenantId).toBe(ctx.tenantId);
    expect(lastCall().authorization).toBe(`Bearer ${apiKey}`);
    expect(lastCall().routeMissing).toBe(false);
  });

  // The outputs rows (and the SSE rows) need a session with a live sandbox and some
  // persisted events, so wake one first: real POST /events → real runtime → real
  // provision on the (fake) provider. Declared before the ladder, so it runs first.
  it(
    "wakes a session: POST /v1/sessions/:id/events provisions a sandbox and returns to idle",
    async () => {
      const agent = await client.createAgent({
        name: "warmup-agent",
        model: { provider: "anthropic", id: "claude-sonnet-4-5" },
      });
      const session = await client.createSession({
        agent: agent.id,
        environmentId: fx.environmentId,
      });
      await client.sendEvent(session.id, { type: "user.message", content: "hello" });

      const provisioned = await waitFor(() =>
        provider.calls.some((c) => c.kind === "provision"),
      );
      expect(provisioned).toBe(true);
      const idle = await waitFor(async () => (await client.getSession(session.id)).status === "idle");
      expect(idle).toBe(true);

      // The warm session is the one the outputs + SSE rows use.
      fx.warmSessionId = session.id;
      fx.sandboxName = provider.calls.find((c) => c.kind === "provision")!.name;
    },
    60_000,
  );

  it.each(cases.map((c) => [c.method, c] as const))(
    "%s → real route, documented status, contract-shaped body",
    async (_name, testCase) => {
      const before = wire.length;
      const result = await testCase.run(client, fx);
      expect(wire.length).toBeGreaterThan(before);

      const call = lastCall();
      // 1. The route EXISTS. This is the assertion the stubbed-fetch test could never
      //    make, and the one that would have caught the R3.1 SSE 404 on day one.
      expect(
        call.routeMissing,
        `${testCase.method}: ${call.method} ${call.path} hit no route (Fastify 404 route-not-found)`,
      ).toBe(false);
      // 2. Method + canonical path.
      expect(call.method.toUpperCase()).toBe(testCase.httpMethod);
      expect(call.path).toMatch(testCase.path);
      // 3. Auth header actually travelled.
      expect(call.authorization).toBe(`Bearer ${apiKey}`);
      // 4. Documented status.
      expect(call.status, `${testCase.method}: unexpected status`).toBe(testCase.status);
      // 5. Response shape per the contracts schema the client claims to return.
      testCase.check?.(result, fx);
    },
    60_000,
  );

  it("covers EVERY public method of ManagedApiClient (no method may ship untested)", () => {
    // `private` is compile-time only — these are the runtime-visible internals.
    const internals = new Set([
      "constructor",
      "request",
      "checkVersion",
      "parseSse",
      "pollSession",
    ]);
    const publicMethods = Object.getOwnPropertyNames(ManagedApiClient.prototype)
      .filter((n) => !internals.has(n))
      .sort();
    const covered = new Set(cases.map((c) => c.method));
    covered.add("streamSession"); // exercised by the SSE tests below.
    const uncovered = publicMethods.filter((m) => !covered.has(m));
    expect(uncovered, `uncovered ManagedApiClient methods: ${uncovered.join(", ")}`).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // SSE (R3.1) — the bug that motivated this suite.
  // -------------------------------------------------------------------------

  it(
    "streamSession connects to the canonical /v1/sessions/:id/stream and receives frames",
    async () => {
      const ctrl = new AbortController();
      const frames: ParsedSseFrame[] = [];
      const timer = setTimeout(() => ctrl.abort(), 20_000);
      try {
        for await (const frame of client.streamSession(fx.warmSessionId, {
          signal: ctrl.signal,
        })) {
          frames.push(frame);
          if (frames.length >= 2) break;
        }
      } finally {
        clearTimeout(timer);
        ctrl.abort();
      }

      const streamCall = wire.filter((c) => c.path.endsWith("/stream")).at(-1)!;
      // The canonical path (§8.4/§9.3/§24.7) — NOT `/events/stream`, which 404s.
      expect(streamCall.path).toBe(`/v1/sessions/${fx.warmSessionId}/stream`);
      expect(streamCall.routeMissing).toBe(false);
      expect(streamCall.status).toBe(200);
      expect(streamCall.authorization).toBe(`Bearer ${apiKey}`);
      // Real SSE frames, parsed by the client's own frame parser.
      expect(frames.length).toBeGreaterThan(0);
      for (const f of frames) {
        expect(typeof f.event).toBe("string");
        expect(f.id).toBeTypeOf("number");
      }
      // The replayed frames are the session's real lifecycle events.
      expect(frames.map((f) => f.event).some((e) => e.startsWith("session."))).toBe(true);
    },
    40_000,
  );

  it(
    "polling fallback (§24.10): SSE transport dead → GET /v1/sessions/:id/events yields frames",
    async () => {
      const polling = new ManagedApiClient({
        backendUrl: baseUrl,
        getApiKey: () => apiKey,
        fetchImpl: recordingFetch({ breakSse: true }),
        pollingIntervalMs: 50,
        streamTimeoutMs: 10_000,
      });

      const ctrl = new AbortController();
      const frames: ParsedSseFrame[] = [];
      const timer = setTimeout(() => ctrl.abort(), 10_000);
      try {
        for await (const frame of polling.streamSession(fx.warmSessionId, {
          signal: ctrl.signal,
        })) {
          frames.push(frame);
          if (frames.length >= 1) break;
        }
      } finally {
        clearTimeout(timer);
        ctrl.abort();
      }

      expect(frames.length).toBeGreaterThan(0);
      // It fell back to the real, existing history route (not a stub, not a 404).
      const pollCall = wire.filter((c) => c.path.endsWith("/events") && c.method === "GET").at(-1)!;
      expect(pollCall.path).toBe(`/v1/sessions/${fx.warmSessionId}/events`);
      expect(pollCall.status).toBe(200);
      expect(pollCall.routeMissing).toBe(false);
      expect(frames[0].id).toBeTypeOf("number");
    },
    40_000,
  );

  it(
    "R3.1 regression: the pre-fix SSE path /v1/sessions/:id/events/stream 404s and degrades to polling",
    async () => {
      // Simulates the SHIPPED bug without touching api-client.ts: rewrite only the SSE
      // request to the path the old client used. The backend answers 404 route-not-found,
      // the client silently degrades to polling, and the live-view panel never connects.
      // The previous test's `expect(streamCall.path).toBe(.../stream)` +
      // `expect(streamCall.status).toBe(200)` are therefore load-bearing: with this URL
      // they go red. That is the test that would have caught R3.1 on day one.
      const legacy = new ManagedApiClient({
        backendUrl: baseUrl,
        getApiKey: () => apiKey,
        fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          const rewritten = url.replace(/\/stream(\?|$)/, "/events/stream$1");
          return recordingFetch()(rewritten, init);
        }) as FetchImpl,
        pollingIntervalMs: 50,
        streamTimeoutMs: 5_000,
      });

      const ctrl = new AbortController();
      const frames: ParsedSseFrame[] = [];
      const timer = setTimeout(() => ctrl.abort(), 8_000);
      try {
        for await (const frame of legacy.streamSession(fx.warmSessionId, { signal: ctrl.signal })) {
          frames.push(frame);
          break;
        }
      } finally {
        clearTimeout(timer);
        ctrl.abort();
      }

      const sseCall = wire.find((c) => c.path === `/v1/sessions/${fx.warmSessionId}/events/stream`);
      expect(sseCall, "the legacy SSE path was never requested").toBeDefined();
      expect(sseCall!.status).toBe(404);
      expect(sseCall!.routeMissing).toBe(true);
      // …and the failure is SILENT: the client yields polled frames, so no caller ever
      // sees an error. Only a real-backend test can see this.
      expect(frames.length).toBeGreaterThan(0);
    },
    30_000,
  );

  it("a wrong path yields a route-not-found 404 (proves the detector actually detects)", async () => {
    // Negative control for assertion #1 above: the pre-R3.1 client streamed
    // `/v1/sessions/:id/events/stream`. If the detector were broken, every row would
    // pass vacuously.
    await expect(
      client.fetchJson(`/v1/sessions/${fx.warmSessionId}/events/stream`),
    ).rejects.toBeInstanceOf(ApiClientError);
    expect(lastCall().status).toBe(404);
    expect(lastCall().routeMissing).toBe(true);
  });
});
