// @vitest-environment node
/**
 * Contract tests for the WP-C3.2 environments surface against the REAL
 * in-process backend (CONVENTIONS.md "Fakes at the seam": testcontainers
 * Postgres, the real Fastify app on an ephemeral port, real global `fetch`).
 *
 * Covers the §9.2 mutations the prep suite left to this WP: create/PATCH/
 * archive/DELETE round-trips, worker-key mint (show-once response shape; the
 * RECORD in `/v1/api-keys` carries the `self_hosted_worker:<envId>` scope
 * marker and never the raw key), `work-stats` over a genuinely seeded queue
 * (via the backend's exported `enqueue` — no real worker needed), and
 * `work-stop` clean → force, including the 422 when `sessionId` is missing.
 *
 * Run with `PI_REQUIRE_INTEGRATION=containers` so a missing container
 * runtime fails instead of silently skipping.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enqueue } from "@pi-managed/backend";
import { Agent, Session } from "@pi-managed/contracts";
import { ConsoleApiClient } from "../client.js";
import { listApiKeys, workerKeyScopeOf } from "../api-keys.js";
import {
  archiveEnvironment,
  createEnvironment,
  deleteEnvironment,
  getEnvironment,
  getWorkStats,
  mintWorkerKey,
  stopWork,
  updateEnvironment,
} from "../environments.js";
import {
  requireContainers,
  startTestBackend,
  type TestBackend,
} from "./harness.js";

const RUNTIME = requireContainers("web-console environments contract suite");

describe.skipIf(!RUNTIME)("environments client ↔ real backend (WP-C3.2)", () => {
  let backend: TestBackend;
  /** Bearer-authed client (admin scope) — an init override, not a transport fake. */
  let admin: ConsoleApiClient;

  beforeAll(async () => {
    backend = await startTestBackend();
    admin = new ConsoleApiClient({
      baseUrl: backend.baseUrl,
      headers: { Authorization: `Bearer ${backend.adminKey}` },
    });
  }, 120_000);

  afterAll(async () => {
    if (backend) await backend.stop();
  }, 120_000);

  describe("lifecycle (create / PATCH / archive / DELETE)", () => {
    it("round-trips a cloud environment through its whole lifecycle", async () => {
      const env = await createEnvironment(
        {
          name: "c32-lifecycle",
          type: "cloud",
          image: "ubuntu:22.04",
          networking: { mode: "limited", allowedHosts: ["api.github.com"] },
        },
        admin,
      );
      expect(env.status).toBe("active");
      expect(env.networking).toEqual({
        mode: "limited",
        allowedHosts: ["api.github.com"],
      });

      // PATCH is not versioned — the same resource comes back updated.
      const patched = await updateEnvironment(
        env.id,
        { name: "c32-lifecycle-v2" },
        admin,
      );
      expect(patched.id).toBe(env.id);
      expect(patched.name).toBe("c32-lifecycle-v2");

      const archived = await archiveEnvironment(env.id, admin);
      expect(archived.status).toBe("archived");

      await deleteEnvironment(env.id, admin);
      await expect(getEnvironment(env.id, admin)).rejects.toMatchObject({
        status: 404,
        code: "not_found",
      });
    });
  });

  describe("self-hosted worker surface (W12)", () => {
    let envId: string;

    beforeAll(async () => {
      envId = (
        await createEnvironment({ name: "c32-workers", type: "self_hosted" }, admin)
      ).id;
    }, 60_000);

    it("mints a worker key: shown-once shape, and the LIST record carries only the scope marker", async () => {
      const issued = await mintWorkerKey(envId, { name: "worker-host-1" }, admin);
      expect(issued.environmentId).toBe(envId);
      expect(issued.name).toBe("worker-host-1");
      expect(issued.key).toMatch(/^pmb_live_/);

      const page = await listApiKeys(admin);
      const record = page.data.find((k) => k.id === issued.id);
      expect(record).toBeDefined();
      expect(workerKeyScopeOf(record!)).toBe(envId);
      // The raw key exists ONLY in the mint response (C§13 secret-absence).
      expect(record).not.toHaveProperty("key");
      expect(JSON.stringify(page)).not.toContain(issued.key);
    });

    it("work-stats reflects a seeded queue; work-stop drains clean → force", async () => {
      // Idle queue answers the zero shape.
      expect(await getWorkStats(envId, admin)).toEqual({
        depth: 0,
        pending: 0,
        oldestQueuedAt: null,
        workersPolling: 0,
      });

      // Seed one queued work item exactly like the backend's own work-queue
      // tests: a session on the environment (the queue's session FK), then
      // the exported `enqueue` — no real worker is needed for stats.
      const agent = await admin.post(
        "/v1/agents",
        {
          name: "c32-agent",
          model: { provider: "anthropic", id: "claude-sonnet-4" },
        },
        Agent,
      );
      const session = await admin.post(
        "/v1/sessions",
        { agent: agent.id, environmentId: envId },
        Session,
      );
      await enqueue(
        backend.pool,
        { tenantId: backend.tenantId },
        session.id,
        envId,
        { initialEvents: [{ type: "user.message", content: "run tests" }] },
      );

      const stats = await getWorkStats(envId, admin);
      expect(stats).toMatchObject({ depth: 1, pending: 1, workersPolling: 0 });
      expect(stats.oldestQueuedAt).not.toBeNull();

      // Clean stop first (§9.2: force is the explicit second step)…
      const clean = await stopWork(envId, { sessionId: session.id }, admin);
      expect(clean.sessionId).toBe(session.id);
      expect(clean.stopRequested).toBe("clean");

      // …then force.
      const forced = await stopWork(
        envId,
        { sessionId: session.id, force: true },
        admin,
      );
      expect(forced.stopRequested).toBe("force");
    });

    it("work-stop without a sessionId is a 422 (the body field is required)", async () => {
      await expect(
        admin.post(`/v1/environments/${envId}/work-stop`, {}, {
          parse: (x: unknown) => x,
        }),
      ).rejects.toMatchObject({ status: 422, code: "invalid_request" });
    });

    it("work-stats on a cloud environment is a 422 (queue does not apply)", async () => {
      const cloud = await createEnvironment(
        { name: "c32-cloud", type: "cloud" },
        admin,
      );
      await expect(getWorkStats(cloud.id, admin)).rejects.toMatchObject({
        status: 422,
        code: "invalid_request",
      });
      await deleteEnvironment(cloud.id, admin);
    });

    it("read scope cannot mint a worker key (write-guarded route)", async () => {
      const reader = new ConsoleApiClient({
        baseUrl: backend.baseUrl,
        headers: { Authorization: `Bearer ${backend.readKey}` },
      });
      await expect(
        mintWorkerKey(envId, { name: "sneaky" }, reader),
      ).rejects.toMatchObject({ status: 403 });
    });
  });
});
