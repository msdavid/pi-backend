/**
 * WP-2.6 tests — `/remote:cron` + `/remote:jobs` command round-trips.
 */
import { describe, it, expect, vi } from "vitest";
import type { ManagedApiClient } from "../api-client.js";
import type { Job, JobRun, Cursor } from "@pi-managed/contracts";
import {
  runCronList,
  runCronCreate,
  runCronPause,
  runCronUnpause,
  runCronRun,
  runCronArchive,
  runJobs,
} from "./cron.js";

function makeJob(over: Partial<Job> = {}): Job {
  return {
    id: "job_1",
    name: "nightly",
    status: "active",
    agent: "agent_1",
    environmentId: "env_1",
    schedule: { cron: "0 7 * * 1-5", tz: "America/New_York" },
    oneShot: false,
    createdAt: "2026-07-13T12:00:00Z",
    updatedAt: "2026-07-13T12:00:00Z",
    ...over,
  };
}

function makeRun(over: Partial<JobRun> = {}): JobRun {
  return {
    id: "run_1",
    scheduledAt: "2026-07-13T07:00:00Z",
    manual: true,
    createdAt: "2026-07-13T07:00:01Z",
    ...over,
  };
}

interface Call {
  method: string;
  args: unknown[];
}

function makeClient(over: Partial<ManagedApiClient> = {}): { client: ManagedApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    listJobs: (q?: unknown) => {
      calls.push({ method: "listJobs", args: [q] });
      return Promise.resolve<Cursor<Job>>({ data: [makeJob()], nextCursor: null });
    },
    createJob: (body: unknown) => {
      calls.push({ method: "createJob", args: [body] });
      return Promise.resolve(makeJob({ id: "job_new" }));
    },
    pauseJob: (id: string) => {
      calls.push({ method: "pauseJob", args: [id] });
      return Promise.resolve(makeJob({ id, status: "paused" }));
    },
    unpauseJob: (id: string) => {
      calls.push({ method: "unpauseJob", args: [id] });
      return Promise.resolve(makeJob({ id, status: "active" }));
    },
    archiveJob: (id: string) => {
      calls.push({ method: "archiveJob", args: [id] });
      return Promise.resolve(makeJob({ id, status: "archived" }));
    },
    runJob: (id: string) => {
      calls.push({ method: "runJob", args: [id] });
      return Promise.resolve({ runId: "run_x", sessionId: "sess_x" });
    },
    listJobRuns: (id: string, q?: unknown) => {
      calls.push({ method: "listJobRuns", args: [id, q] });
      return Promise.resolve<Cursor<JobRun>>({ data: [makeRun()], nextCursor: null });
    },
    ...over,
  } as unknown as ManagedApiClient;
  return { client, calls };
}

function makeDeps(client: ManagedApiClient | undefined) {
  const notifies: { msg: string; type?: string }[] = [];
  const widgets: { key: string; lines: string[] }[] = [];
  const statuses: { key: string; text: string }[] = [];
  const inputs = vi.fn();
  return {
    deps: {
      ui: {
        notify: (msg: string, type?: "info" | "warning" | "error") => notifies.push({ msg, type }),
        setWidget: (key: string, lines: string[] | undefined) => lines && widgets.push({ key, lines }),
        setStatus: (key: string, text: string | undefined) => text && statuses.push({ key, text }),
        input: inputs,
      },
      createClient: () => client,
      defaultAgent: "agent_1",
      defaultEnvironment: "env_1",
    },
    notifies,
    widgets,
    statuses,
    inputs,
  };
}

describe("/remote:cron + /remote:jobs commands (§24.5, §17)", () => {
  it("not configured → notifies and returns", async () => {
    const { deps, notifies } = makeDeps(undefined);
    await runCronList(deps);
    expect(notifies[0]?.msg).toMatch(/not configured/);
  });

  it("list renders job rows", async () => {
    const { client } = makeClient();
    const { deps, widgets } = makeDeps(client);
    await runCronList(deps);
    expect(widgets[0]?.lines[0]).toBe("Scheduled jobs:");
    expect(widgets[0]?.lines[1]).toContain("job_1");
  });

  it("create prompts and creates a job with initialEvents", async () => {
    const { client, calls } = makeClient();
    const { deps, inputs, notifies } = makeDeps(client);
    inputs
      .mockResolvedValueOnce("nightly-test") // name
      .mockResolvedValueOnce("0 7 * * 1-5") // cron
      .mockResolvedValueOnce("America/New_York") // tz
      .mockResolvedValueOnce("run the suite"); // message
    await runCronCreate(deps);
    const createCall = calls.find((c) => c.method === "createJob");
    expect(createCall?.args[0]).toMatchObject({
      name: "nightly-test",
      agent: "agent_1",
      environmentId: "env_1",
      initialEvents: [{ type: "user.message", content: "run the suite" }],
      schedule: { cron: "0 7 * * 1-5", tz: "America/New_York" },
    });
    expect(notifies.some((n) => n.msg.includes("job_new"))).toBe(true);
  });

  it("create aborts if name prompt is empty", async () => {
    const { client, calls } = makeClient();
    const { deps, inputs } = makeDeps(client);
    inputs.mockResolvedValueOnce(undefined);
    await runCronCreate(deps);
    expect(calls.find((c) => c.method === "createJob")).toBeUndefined();
  });

  it("pause / unpause / archive / run dispatch by jobId", async () => {
    const { client, calls } = makeClient();
    const { deps, notifies } = makeDeps(client);
    await runCronPause(deps, "job_1");
    await runCronUnpause(deps, "job_1");
    await runCronArchive(deps, "job_1");
    await runCronRun(deps, "job_1");
    expect(calls.map((c) => c.method)).toEqual([
      "pauseJob",
      "unpauseJob",
      "archiveJob",
      "runJob",
    ]);
    expect(notifies.some((n) => n.msg.includes("Paused"))).toBe(true);
    expect(notifies.some((n) => n.msg.includes("Resumed"))).toBe(true);
    expect(notifies.some((n) => n.msg.includes("Archived"))).toBe(true);
    expect(notifies.some((n) => n.msg.includes("Triggered run run_x"))).toBe(true);
  });

  it("pause without jobId → usage error", async () => {
    const { client, calls } = makeClient();
    const { deps, notifies } = makeDeps(client);
    await runCronPause(deps, "");
    expect(calls).toHaveLength(0);
    expect(notifies[0]?.msg).toMatch(/Usage/);
  });

  it("create-then-list round-trip: created job appears in list", async () => {
    let stored: Job[] = [];
    const client = {
      createJob: (body: unknown) => {
        const j = makeJob({ id: "job_new", name: (body as { name: string }).name });
        stored = [j];
        return Promise.resolve(j);
      },
      listJobs: () => Promise.resolve<Cursor<Job>>({ data: stored, nextCursor: null }),
    } as unknown as ManagedApiClient;
    const createDeps = makeDeps(client);
    createDeps.inputs
      .mockResolvedValueOnce("nightly-test")
      .mockResolvedValueOnce("0 7 * * 1-5")
      .mockResolvedValueOnce("America/New_York")
      .mockResolvedValueOnce("run the suite");
    await runCronCreate(createDeps.deps);
    const listDeps = makeDeps(client);
    await runCronList(listDeps.deps);
    expect(listDeps.widgets[0]?.lines[1]).toContain("job_new");
  });

  it("/remote:jobs lists runs for a job", async () => {
    const { client } = makeClient();
    const { deps, widgets } = makeDeps(client);
    await runJobs(deps, "job_1");
    expect(widgets[0]?.lines[0]).toBe("Runs for job job_1:");
    expect(widgets[0]?.lines[1]).toContain("run_1");
  });

  it("/remote:jobs without jobId → usage error", async () => {
    const { client, calls } = makeClient();
    const { deps, notifies } = makeDeps(client);
    await runJobs(deps, "");
    expect(calls).toHaveLength(0);
    expect(notifies[0]?.msg).toMatch(/Usage/);
  });
});
