/**
 * WP-2.6 tests — cron `remote_*` tool definitions + create-then-list round-trip.
 */
import { describe, it, expect } from "vitest";
import { createCronTools } from "./cron-tools.js";
import type { ManagedApiClient } from "../api-client.js";
import type { PiManagedSettings } from "../config.js";
import type { Cursor, Job } from "@pi-managed/contracts";

function makeSettings(over: Partial<PiManagedSettings> = {}): PiManagedSettings {
  return {
    backendUrl: "https://api.example.com",
    apiKeyRef: "ref",
    delegationPolicy: "confirm",
    pollingIntervalMs: 5000,
    streamTimeoutMs: 1_800_000,
    outputsDir: "./.pi-managed/outputs/",
    tenant: "tnt_test",
    defaultAgent: "agent_1",
    defaultEnvironment: "env_1",
    ...over,
  } as PiManagedSettings;
}

interface Call {
  method: string;
  args: unknown[];
}

function makeClient(): { client: ManagedApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    createJob: (body: unknown) => {
      calls.push({ method: "createJob", args: [body] });
      return Promise.resolve({
        id: "job_new",
        status: "active",
        name: (body as { name: string }).name,
        schedule: (body as { schedule: { cron: string; tz: string } }).schedule,
        agent: "agent_1",
        environmentId: "env_1",
        oneShot: false,
        createdAt: "2026-07-13T12:00:00Z",
        updatedAt: "2026-07-13T12:00:00Z",
      });
    },
    listJobs: () => {
      calls.push({ method: "listJobs", args: [] });
      return Promise.resolve<Cursor<Job>>({ data: [], nextCursor: null });
    },
    pauseJob: (id: string) => {
      calls.push({ method: "pauseJob", args: [id] });
      return Promise.resolve({ id, status: "paused" });
    },
    runJob: (id: string) => {
      calls.push({ method: "runJob", args: [id] });
      return Promise.resolve({ runId: "run_x", sessionId: "sess_x" });
    },
  } as unknown as ManagedApiClient;
  return { client, calls };
}

function makeTools(settings: PiManagedSettings = makeSettings()) {
  const { client, calls } = makeClient();
  const tools = createCronTools({ client: () => client, settings: () => settings });
  return { tools, calls, client };
}

describe("WP-2.6 cron tools", () => {
  it("defines 4 tools with detailed descriptions (>200 chars)", () => {
    const { tools } = makeTools();
    expect(tools).toHaveLength(4);
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "remote_create_cron",
        "remote_list_crons",
        "remote_pause_cron",
        "remote_run_cron",
      ]),
    );
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(200);
      expect(t.name).toMatch(/^remote_/);
    }
  });

  it("remote_create_cron builds a JobCreate with initialEvents", async () => {
    const { tools, calls } = makeTools();
    const create = tools.find((t) => t.name === "remote_create_cron")!;
    const res = await create.execute(
      "tc1",
      { name: "nightly", cron: "0 7 * * 1-5", tz: "America/New_York", message: "run tests" },
      undefined,
      undefined,
      undefined as unknown,
    );
    expect(res.details).toMatchObject({ jobId: "job_new", status: "active" });
    const call = calls.find((c) => c.method === "createJob");
    expect(call?.args[0]).toMatchObject({
      name: "nightly",
      agent: "agent_1",
      environmentId: "env_1",
      initialEvents: [{ type: "user.message", content: "run tests" }],
      schedule: { cron: "0 7 * * 1-5", tz: "America/New_York" },
    });
  });

  it("remote_create_cron honors oneShot", async () => {
    const { tools, calls } = makeTools();
    const create = tools.find((t) => t.name === "remote_create_cron")!;
    await create.execute(
      "tc1",
      { name: "deleg", cron: "* * * * *", tz: "UTC", message: "do it", oneShot: true },
      undefined,
      undefined,
      undefined as unknown,
    );
    const call = calls.find((c) => c.method === "createJob");
    expect((call?.args[0] as { oneShot: boolean }).oneShot).toBe(true);
  });

  it("remote_pause_cron returns paused status", async () => {
    const { tools, calls } = makeTools();
    const pause = tools.find((t) => t.name === "remote_pause_cron")!;
    const res = await pause.execute("tc1", { jobId: "job_1" }, undefined, undefined, undefined as unknown);
    expect(res.details).toMatchObject({ jobId: "job_1", status: "paused" });
    expect(calls[0]).toMatchObject({ method: "pauseJob", args: ["job_1"] });
  });

  it("remote_run_cron returns runId + sessionId", async () => {
    const { tools } = makeTools();
    const run = tools.find((t) => t.name === "remote_run_cron")!;
    const res = await run.execute("tc1", { jobId: "job_1" }, undefined, undefined, undefined as unknown);
    expect(res.details).toMatchObject({ runId: "run_x", sessionId: "sess_x" });
  });

  it("create-then-list round-trip", async () => {
    let stored: Job[] = [];
    const client = {
      createJob: (body: unknown) => {
        const j = {
          id: "job_new",
          status: "active",
          name: (body as { name: string }).name,
          schedule: (body as { schedule: { cron: string; tz: string } }).schedule,
          agent: "agent_1",
          environmentId: "env_1",
          oneShot: false,
          createdAt: "2026-07-13T12:00:00Z",
          updatedAt: "2026-07-13T12:00:00Z",
        } as unknown as Job;
        stored = [j];
        return Promise.resolve(j);
      },
      listJobs: () => Promise.resolve<Cursor<Job>>({ data: stored, nextCursor: null }),
    } as unknown as ManagedApiClient;
    const tools = createCronTools({ client: () => client, settings: () => makeSettings() });
    const create = tools.find((t) => t.name === "remote_create_cron")!;
    await create.execute(
      "tc1",
      { name: "nightly", cron: "0 7 * * 1-5", tz: "UTC", message: "go" },
      undefined,
      undefined,
      undefined as unknown,
    );
    const list = tools.find((t) => t.name === "remote_list_crons")!;
    const res = await list.execute("tc1", {}, undefined, undefined, undefined as unknown);
    expect((res.details as { jobs: Job[] }).jobs).toHaveLength(1);
    expect((res.details as { jobs: Job[] }).jobs[0].id).toBe("job_new");
  });

  it("throws if backend not configured", async () => {
    const tools = createCronTools({ client: () => null, settings: () => makeSettings() });
    const list = tools.find((t) => t.name === "remote_list_crons")!;
    await expect(
      list.execute("tc1", {}, undefined, undefined, undefined as unknown),
    ).rejects.toThrow(/not configured/);
  });
});
