// @vitest-environment node
/**
 * Contract tests for the WP-C3.5 jobs lifecycle fetchers — `createJob`,
 * `pauseJob`, `unpauseJob`, `archiveJob` in `src/api/jobs.ts` — against the
 * REAL in-process backend (CONVENTIONS.md "Fakes at the seam": testcontainers
 * Postgres, the real Fastify app on an ephemeral port, real global `fetch`).
 * Seeding happens through the API itself, like `jobs-memory.contract.test.ts`
 * (which owns the read-side coverage).
 *
 * Run with `PI_REQUIRE_INTEGRATION=containers` so a missing container
 * runtime fails instead of silently skipping.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent, Environment } from "@pi-managed/contracts";
import { ConsoleApiClient, ConsoleApiError } from "../client.js";
import {
  archiveJob,
  createJob,
  getJob,
  listJobRuns,
  listJobs,
  pauseJob,
  triggerJobRun,
  unpauseJob,
} from "../jobs.js";
import {
  requireContainers,
  startTestBackend,
  type TestBackend,
} from "./harness.js";

const RUNTIME = requireContainers("web-console jobs lifecycle contract suite");

describe.skipIf(!RUNTIME)("jobs lifecycle client ↔ real backend", () => {
  let backend: TestBackend;
  /** Bearer-authed clients — init overrides, not transport fakes. */
  let admin: ConsoleApiClient;
  let readOnly: ConsoleApiClient;
  let agentId: string;
  let environmentId: string;

  beforeAll(async () => {
    backend = await startTestBackend();
    admin = new ConsoleApiClient({
      baseUrl: backend.baseUrl,
      headers: { Authorization: `Bearer ${backend.adminKey}` },
    });
    readOnly = new ConsoleApiClient({
      baseUrl: backend.baseUrl,
      headers: { Authorization: `Bearer ${backend.readKey}` },
    });
    const agent = await admin.post(
      "/v1/agents",
      {
        name: "console-lifecycle-agent",
        model: { provider: "anthropic", id: "claude-sonnet-4" },
      },
      Agent,
    );
    agentId = agent.id;
    const env = await admin.post(
      "/v1/environments",
      { name: "console-lifecycle-env", type: "cloud" },
      Environment,
    );
    environmentId = env.id;
  }, 120_000);

  afterAll(async () => {
    if (backend) await backend.stop();
  }, 120_000);

  it("create → pause → unpause → archive round-trips through the contracts schemas", async () => {
    const created = await createJob(
      {
        name: "console-lifecycle-job",
        agent: agentId,
        environmentId,
        initialEvents: [{ type: "user.message", content: "go" }],
        schedule: { cron: "0 7 * * 1-5", tz: "America/New_York" },
      },
      admin,
    );
    expect(created.id).toMatch(/^job_/);
    expect(created.status).toBe("active");
    expect(created.schedule).toEqual({
      cron: "0 7 * * 1-5",
      tz: "America/New_York",
    });
    expect(created.oneShot).toBe(false);
    expect(created.pausedReason).toBeUndefined();

    const paused = await pauseJob(created.id, admin);
    expect(paused.status).toBe("paused");
    expect(paused.pausedReason).toEqual({ type: "manual" });

    const resumed = await unpauseJob(created.id, admin);
    expect(resumed.status).toBe("active");
    expect(resumed.pausedReason).toBeUndefined();

    const archived = await archiveJob(created.id, admin);
    expect(archived.status).toBe("archived");
    // Terminal (§17.5): archive is idempotent, but the archived job is
    // INVISIBLE on every read — list excludes it, detail/runs/trigger 404.
    // This is what the console's archive flow (navigate away, drop the
    // detail cache) and the fake's read side are built on.
    const again = await archiveJob(created.id, admin);
    expect(again.status).toBe("archived");
    for (const attempt of [
      () => triggerJobRun(created.id, admin),
      () => getJob(created.id, admin),
      () => listJobRuns(created.id, {}, admin),
    ]) {
      const err: unknown = await attempt().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConsoleApiError);
      expect((err as ConsoleApiError).status).toBe(404);
    }
    const page = await listJobs({}, admin);
    expect(page.data.map((j) => j.id)).not.toContain(created.id);
  });

  it("a one-shot create echoes oneShot: true", async () => {
    const created = await createJob(
      {
        name: "console-lifecycle-oneshot",
        agent: agentId,
        environmentId,
        initialEvents: [{ type: "user.message", content: "once" }],
        schedule: { cron: "0 8 * * *", tz: "UTC" },
        oneShot: true,
      },
      admin,
    );
    expect(created.oneShot).toBe(true);
    await archiveJob(created.id, admin);
  });

  it("the server remains the schedule authority: bad cron and bad tz → 422", async () => {
    const base = {
      name: "console-lifecycle-invalid",
      agent: agentId,
      environmentId,
      initialEvents: [{ type: "user.message", content: "go" } as const],
    };

    const badCron: unknown = await createJob(
      { ...base, schedule: { cron: "not a cron", tz: "UTC" } },
      admin,
    ).catch((e: unknown) => e);
    expect(badCron).toBeInstanceOf(ConsoleApiError);
    expect((badCron as ConsoleApiError).status).toBe(422);
    expect((badCron as ConsoleApiError).code).toBe("invalid_request");

    const badTz: unknown = await createJob(
      { ...base, schedule: { cron: "0 7 * * *", tz: "Mars/Olympus_Mons" } },
      admin,
    ).catch((e: unknown) => e);
    expect(badTz).toBeInstanceOf(ConsoleApiError);
    expect((badTz as ConsoleApiError).status).toBe(422);
    expect((badTz as ConsoleApiError).message).toContain(
      "unknown IANA timezone",
    );
  });

  it("a read-scoped key cannot create: real 403 with the DP-9 facts", async () => {
    const err: unknown = await createJob(
      {
        name: "console-lifecycle-denied",
        agent: agentId,
        environmentId,
        initialEvents: [{ type: "user.message", content: "go" }],
        schedule: { cron: "0 7 * * *", tz: "UTC" },
      },
      readOnly,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConsoleApiError);
    const apiErr = err as ConsoleApiError;
    expect(apiErr.status).toBe(403);
    expect(apiErr.code).toBe("forbidden");
    expect(apiErr.requestId).toBeTruthy();
  });
});
