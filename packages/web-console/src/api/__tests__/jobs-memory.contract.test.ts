// @vitest-environment node
/**
 * Contract tests for the WP-C2.4 client modules — `src/api/jobs.ts` +
 * `src/api/memory-stores.ts` (+ the WP-C4.0b version-restore op) —
 * against the REAL in-process backend
 * (CONVENTIONS.md "Fakes at the seam": both sides real — testcontainers
 * Postgres, the real Fastify app on an ephemeral port, real global `fetch`).
 * Seeding happens through the API itself, like `contract.test.ts`.
 *
 * Run with `PI_REQUIRE_INTEGRATION=containers` so a missing container
 * runtime fails instead of silently skipping.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FilesystemObjectStore } from "@pi-managed/backend";
import {
  Agent,
  Environment,
  Job,
  Memory,
  MemoryStore,
  MemoryVersion,
} from "@pi-managed/contracts";
import { ConsoleApiClient, ConsoleApiError } from "../client.js";
import { getJob, listJobs, listJobRuns, triggerJobRun } from "../jobs.js";
import {
  getMemory,
  getMemoryStore,
  getMemoryVersion,
  listMemories,
  listMemoryStores,
  listMemoryVersions,
  restoreMemoryVersion,
} from "../memory-stores.js";
import {
  requireContainers,
  startTestBackend,
  type TestBackend,
} from "./harness.js";

const RUNTIME = requireContainers("web-console jobs+memory contract suite");

/** Well-formed but non-existent ids (ULID payloads). */
const MISSING_JOB_ID = "job_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const MISSING_STORE_ID = "mem_01ARZ3NDEKTSV4RRFFQ69G5FAV";

describe.skipIf(!RUNTIME)("jobs + memory-stores clients ↔ real backend", () => {
  let backend: TestBackend;
  /** Bearer-authed client (admin scope) — an init override, not a transport fake. */
  let admin: ConsoleApiClient;
  let agentId: string;
  let environmentId: string;
  /** Memory content lives in the object store — a real filesystem one. */
  const objectRoot = mkdtempSync(join(tmpdir(), "pi-console-mem-"));

  beforeAll(async () => {
    backend = await startTestBackend({
      app: { objectStore: new FilesystemObjectStore({ root: objectRoot }) },
    });
    admin = new ConsoleApiClient({
      baseUrl: backend.baseUrl,
      headers: { Authorization: `Bearer ${backend.adminKey}` },
    });
    const agent = await admin.post(
      "/v1/agents",
      {
        name: "console-jobs-agent",
        model: { provider: "anthropic", id: "claude-sonnet-4" },
      },
      Agent,
    );
    agentId = agent.id;
    const env = await admin.post(
      "/v1/environments",
      { name: "console-jobs-env", type: "cloud" },
      Environment,
    );
    environmentId = env.id;
  }, 120_000);

  afterAll(async () => {
    if (backend) await backend.stop();
    rmSync(objectRoot, { recursive: true, force: true });
  }, 120_000);

  function createJob(name: string): Promise<Job> {
    return admin.post(
      "/v1/jobs",
      {
        name,
        agent: agentId,
        environmentId,
        initialEvents: [{ type: "user.message", content: "go" }],
        schedule: { cron: "0 7 * * 1-5", tz: "UTC" },
      },
      Job,
    );
  }

  describe("jobs", () => {
    it("empty list → { data: [], nextCursor: null }", async () => {
      const page = await listJobs({}, admin);
      expect(page).toEqual({ data: [], nextCursor: null });
    });

    it("paginates /v1/jobs with the opaque cursor convention", async () => {
      const created = [
        (await createJob("console-job-a")).id,
        (await createJob("console-job-b")).id,
        (await createJob("console-job-c")).id,
      ];

      const first = await listJobs({ limit: 2 }, admin);
      expect(first.data).toHaveLength(2);
      expect(typeof first.nextCursor).toBe("string");
      const second = await listJobs({ limit: 2, cursor: first.nextCursor! }, admin);
      expect(second.data).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      const seen = [...first.data, ...second.data].map((j) => j.id).sort();
      expect(seen).toEqual([...created].sort());
    });

    it("status filter narrows the RESULT SET server-side; pausedReason parses", async () => {
      const paused = await createJob("console-job-paused");
      await admin.post(`/v1/jobs/${paused.id}/pause`, {}, Job);

      const page = await listJobs({ status: "paused" }, admin);
      expect(page.data.map((j) => j.id)).toEqual([paused.id]);

      const detail = await getJob(paused.id, admin);
      expect(detail.status).toBe("paused");
      expect(detail.pausedReason).toEqual({ type: "manual" });
    });

    it("manual trigger → 202 {runId}; the run lists as manual with its session", async () => {
      const job = await createJob("console-job-run");
      expect(await listJobRuns(job.id, {}, admin)).toEqual({
        data: [],
        nextCursor: null,
      });

      const triggered = await triggerJobRun(job.id, admin);
      expect(triggered.runId).toBeTruthy();

      const runs = await listJobRuns(job.id, {}, admin);
      expect(runs.data).toHaveLength(1);
      const run = runs.data[0]!;
      expect(run.id).toBe(triggered.runId);
      expect(run.manual).toBe(true);
      expect(run.sessionId).toBe(triggered.sessionId);
    });

    it("real 404 → ConsoleApiError with the DP-9 facts", async () => {
      const err: unknown = await getJob(MISSING_JOB_ID, admin).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ConsoleApiError);
      const apiErr = err as ConsoleApiError;
      expect(apiErr.status).toBe(404);
      expect(apiErr.code).toBe("not_found");
      expect(apiErr.requestId).toBeTruthy();
    });
  });

  describe("memory stores", () => {
    let storeId: string;

    beforeAll(async () => {
      const store = await admin.post(
        "/v1/memory-stores",
        { displayTitle: "Console contract notes", instructions: "Keep it tidy." },
        MemoryStore,
      );
      storeId = store.id;
      await admin.post(
        `/v1/memory-stores/${storeId}/memories`,
        { path: "conventions.md", content: "Use absolute imports." },
        Memory,
      );
      await admin.post(
        `/v1/memory-stores/${storeId}/memories`,
        { path: "notes/state.json", content: '{"phase": 2}' },
        Memory,
      );
    }, 60_000);

    it("list + retrieve parse with the contracts schemas", async () => {
      const page = await listMemoryStores({}, admin);
      expect(page.data.map((s) => s.id)).toContain(storeId);
      expect(page.nextCursor).toBeNull();

      const store = await getMemoryStore(storeId, admin);
      expect(store.displayTitle).toBe("Console contract notes");
      expect(store.access).toBe("read_write");
      expect(store.status).toBe("active");
    });

    it("memories list is the summary view; retrieve returns the content", async () => {
      const page = await listMemories(storeId, {}, admin);
      expect(page.data.map((m) => m.path).sort()).toEqual([
        "conventions.md",
        "notes/state.json",
      ]);

      const memory = await getMemory(storeId, "conventions.md", admin);
      expect(memory.content).toBe("Use absolute imports.");
      expect(memory.contentSha256).toMatch(/^[0-9a-f]{64}$/);

      // Paths containing `/` ride percent-encoded as one path param.
      const nested = await getMemory(storeId, "notes/state.json", admin);
      expect(nested.content).toBe('{"phase": 2}');
    });

    it("versions: audit trail lists newest first, filters by memoryPath, retrieves by id", async () => {
      const all = await listMemoryVersions(storeId, {}, admin);
      expect(all.data).toHaveLength(2);
      expect(all.data.map((v) => v.memoryPath).sort()).toEqual([
        "conventions.md",
        "notes/state.json",
      ]);

      const filtered = await listMemoryVersions(
        storeId,
        { memoryPath: "conventions.md" },
        admin,
      );
      expect(filtered.data).toHaveLength(1);
      expect(filtered.data[0]!.memoryPath).toBe("conventions.md");
      expect(filtered.data[0]!.redacted).toBe(false);

      const version = await getMemoryVersion(
        storeId,
        filtered.data[0]!.id,
        admin,
      );
      expect(version).toEqual(filtered.data[0]);
    });

    it("real 404 → ConsoleApiError with the DP-9 facts", async () => {
      const err: unknown = await getMemoryStore(MISSING_STORE_ID, admin).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ConsoleApiError);
      const apiErr = err as ConsoleApiError;
      expect(apiErr.status).toBe(404);
      expect(apiErr.code).toBe("not_found");
      expect(apiErr.requestId).toBeTruthy();
    });

    // WP-C4.0b: the restore op, both sides real. Sequential its — the
    // second redacts a version the first created.
    describe("version restore (WP-C4.0b)", () => {
      const PATH = "restore-me.md";
      /** The version holding "v1" — restored by the first test, then
       * redacted and restored again (→ 409) by the second. */
      let v1Version: { id: string; contentSha256: string };

      it("round-trip: the old content becomes the new live head; history is preserved", async () => {
        await admin.post(
          `/v1/memory-stores/${storeId}/memories`,
          { path: PATH, content: "v1" },
          Memory,
        );
        await admin.patch(
          `/v1/memory-stores/${storeId}/memories/${encodeURIComponent(PATH)}`,
          { content: "v2" },
          Memory,
        );
        const versions = await listMemoryVersions(
          storeId,
          { memoryPath: PATH },
          admin,
        );
        expect(versions.data).toHaveLength(2); // newest first: [v2, v1]
        const [v2ver, v1ver] = versions.data;
        v1Version = v1ver!;

        const created = await restoreMemoryVersion(storeId, v1ver!.id, admin);
        expect(created.id).not.toBe(v1ver!.id); // a NEW version, not a rewrite
        expect(created.memoryPath).toBe(PATH);
        expect(created.contentSha256).toBe(v1ver!.contentSha256);
        expect(created.redacted).toBe(false);

        // Content equality via the memories read path: the live head is v1's
        // content again, copied server-side (no client round-trip).
        const memory = await getMemory(storeId, PATH, admin);
        expect(memory.content).toBe("v1");
        expect(memory.contentSha256).toBe(v1ver!.contentSha256);

        // History preserved, restored version at the newest-first head.
        const after = await listMemoryVersions(
          storeId,
          { memoryPath: PATH },
          admin,
        );
        expect(after.data.map((v) => v.id)).toEqual([
          created.id,
          v2ver!.id,
          v1ver!.id,
        ]);
      });

      it("restoring a redacted version → 409 conflict with the DP-9 facts", async () => {
        // v1's version is no longer the live head, so redact is allowed.
        const redacted = await admin.post(
          `/v1/memory-stores/${storeId}/versions/${v1Version.id}/redact`,
          {},
          MemoryVersion,
        );
        expect(redacted.redacted).toBe(true);

        const err: unknown = await restoreMemoryVersion(
          storeId,
          v1Version.id,
          admin,
        ).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConsoleApiError);
        const apiErr = err as ConsoleApiError;
        expect(apiErr.status).toBe(409);
        expect(apiErr.code).toBe("conflict");
        expect(apiErr.requestId).toBeTruthy();
      });
    });
  });
});
