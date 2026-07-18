// @vitest-environment node
/**
 * Tree / Outputs / Fork contract tests (WP-C2.3 acceptance: "fork
 * round-trip against testkit backend"): the new client fetchers against the
 * REAL in-process backend over real HTTP — real Postgres (testcontainer),
 * real Fastify app, real global `fetch`, and a real cookie console session
 * for the read paths (CONVENTIONS.md "Fakes at the seam": the client↔server
 * wire is the subject, so both sides are real).
 *
 * The session-outputs routes mount only when a sandbox provider + resolver
 * are wired (`CreateAppOptions`, exactly how the composition root wires
 * them); a scripted `SandboxProvider` COLLABORATOR stands in for the
 * microsandbox runtime — the same seam the backend's own
 * `api/__tests__/files.test.ts` fakes — while every byte still crosses the
 * real routes. JSONL-backed tree reads get a real `FilesystemObjectStore`.
 *
 * Covers:
 *  - fork round-trip (W6): fork a seeded session through the real app; the
 *    new session exists (cookie-read of detail + list) with
 *    `forkedFromSessionId` set, and its tree reflects the shared JSONL
 *    (Pi-native tree fork — same `{root, branches}` as the parent);
 *  - tree of a fresh session → the empty tree; seeded JSONL → branches;
 *  - outputs listing over the cookie session + the download route fetched
 *    with ONLY the cookie (what the Outputs tab's `<a href>` rides);
 *  - the idle-only rule: a running session answers `409 session_not_idle`.
 *
 * Run with `PI_REQUIRE_INTEGRATION=containers` so a missing container
 * runtime fails instead of silently skipping.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Session } from "@pi-managed/contracts";
import {
  fetchSessionRow,
  FilesystemObjectStore,
  tenantScopedQuery,
  type SessionSandboxResolver,
} from "@pi-managed/backend";

import { ConsoleApiClient, ConsoleApiError } from "../client.js";
import {
  forkSession,
  getSession,
  getSessionTree,
  listSessionOutputs,
  listSessions,
  sessionOutputDownloadUrl,
} from "../sessions.js";
import {
  ScriptedOutputsSandbox,
  seedSession as seedSessionAs,
  signInCookie,
} from "./collaborators.js";
import {
  requireContainers,
  startTestBackend,
  type TestBackend,
} from "./harness.js";

const RUNTIME = requireContainers("web-console tree/outputs/fork contract suite");

describe.skipIf(!RUNTIME)("sessions tree/outputs/fork ↔ real backend", () => {
  let backend: TestBackend;
  /** Bearer-authed admin client — seeding + the fork write. */
  let admin: ConsoleApiClient;
  /** Cookie-only client (read key) — the browser's read path. */
  let reader: ConsoleApiClient;
  let cookie: string;
  let store: FilesystemObjectStore;
  const sandbox = new ScriptedOutputsSandbox();

  /** Seed agent + environment + one session through the public API. */
  const seedSession = (name: string): Promise<Session> =>
    seedSessionAs(admin, name);

  /** Write JSONL lines to a session's log object (entry ids drive the tree). */
  async function writeLog(sessionId: string, lines: object[]): Promise<void> {
    const row = await fetchSessionRow(
      backend.pool,
      { tenantId: backend.tenantId },
      sessionId,
    );
    const key = (row as { jsonl_object_key: string }).jsonl_object_key;
    const text = `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
    const bytes = new TextEncoder().encode(text);
    await store.put(
      key,
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    );
  }

  beforeAll(async () => {
    store = new FilesystemObjectStore({
      root: mkdtempSync(join(tmpdir(), "pi-console-fork-jsonl-")),
    });
    backend = await startTestBackend({
      app: {
        objectStore: store,
        sandboxProvider: sandbox,
        sandboxResolver: {
          // Every session addresses the one scripted sandbox.
          resolve: async (_ctx, sessionId) => ({
            id: `fake-${sessionId}`,
            name: `fake-${sessionId}`,
            labels: { tenant: backend.tenantId, session: sessionId },
          }),
        } satisfies SessionSandboxResolver,
      },
    });
    admin = new ConsoleApiClient({
      baseUrl: backend.baseUrl,
      headers: { Authorization: `Bearer ${backend.adminKey}` },
    });
    // Real cookie sign-in with the read key — the browser's auth path.
    cookie = await signInCookie(backend.baseUrl, backend.readKey);
    reader = new ConsoleApiClient({
      baseUrl: backend.baseUrl,
      headers: { Cookie: cookie },
    });
  }, 180_000);

  afterAll(async () => {
    if (backend) await backend.stop();
  }, 120_000);

  it("tree of a fresh session parses as the empty tree", async () => {
    const session = await seedSession("tree-empty");
    const tree = await getSessionTree(session.id, reader);
    expect(tree).toEqual({ root: null, branches: [] });
  });

  it(
    "fork round-trip (W6): the fork exists, is linked to its parent, and its tree reflects the shared JSONL",
    { timeout: 30_000 },
    async () => {
      const parent = await seedSession("fork-parent");
      await writeLog(parent.id, [
        { type: "user.message", id: "e1", parentId: null, timestamp: "2026-07-13T12:00:00Z", content: "hi" },
        { type: "agent.message", id: "e2", parentId: "e1", timestamp: "2026-07-13T12:00:01Z", content: "hello" },
      ]);

      // The write goes through the fork fetcher (Idempotency-Key is
      // auto-generated by the client wrapper — the route requires it).
      const fork = await forkSession(parent.id, admin);
      expect(fork.id).not.toBe(parent.id);
      expect(fork.forkedFromSessionId).toBe(parent.id);
      expect(fork.title).toBe("fork-parent (fork)");
      expect(fork.status).toBe("idle");

      // The new session exists for the cookie-authed browser reads: detail…
      const fetched = await getSession(fork.id, reader);
      expect(fetched.forkedFromSessionId).toBe(parent.id);
      // …and the list (what the Tree tab's children scan is derived from).
      const listed = await listSessions({ agentId: fork.agentId }, reader);
      expect(listed.data.map((s) => s.id)).toContain(fork.id);

      // Pi-native tree fork: the fork SHARES the JSONL tree up to the fork
      // point — its tree endpoint serves the same branches as the parent's.
      const expected = {
        root: "e1",
        branches: [
          { id: "e1", parentId: null, type: "user.message" },
          { id: "e2", parentId: "e1", type: "agent.message" },
        ],
      };
      expect(await getSessionTree(fork.id, reader)).toEqual(expected);
      expect(await getSessionTree(parent.id, reader)).toEqual(expected);
    },
  );

  it("outputs: cookie-authed listing, and the download route rides the bare cookie", async () => {
    const session = await seedSession("outputs");
    sandbox.files.set("report.md", "# Report\nfinal content\n");
    sandbox.files.set("data.csv", "a,b\n1,2\n");

    const listing = await listSessionOutputs(session.id, reader);
    expect(listing.data.map((f) => f.name).sort()).toEqual([
      "data.csv",
      "report.md",
    ]);

    // The Outputs tab downloads via a plain `<a href>` — a same-origin GET
    // carrying ONLY the console-session cookie. Reproduce exactly that.
    const res = await fetch(
      `${backend.baseUrl}${sessionOutputDownloadUrl(session.id, "report.md")}`,
      { headers: { Cookie: cookie } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(await res.text()).toBe("# Report\nfinal content\n");

    // And without any credentials the download is refused (401) — the
    // cookie is what authorizes the anchor.
    const anon = await fetch(
      `${backend.baseUrl}${sessionOutputDownloadUrl(session.id, "report.md")}`,
    );
    expect(anon.status).toBe(401);
  });

  it("outputs while not idle → 409 session_not_idle (the tab's microcopy case)", async () => {
    const session = await seedSession("outputs-busy");
    await tenantScopedQuery(
      backend.pool,
      { tenantId: backend.tenantId },
      `UPDATE sessions SET status = 'running' WHERE tenant_id = $1 AND id = $2`,
      [backend.tenantId, session.id],
    );

    const err: unknown = await listSessionOutputs(session.id, reader).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConsoleApiError);
    const apiErr = err as ConsoleApiError;
    expect(apiErr.status).toBe(409);
    expect(apiErr.code).toBe("session_not_idle");
  });
});
