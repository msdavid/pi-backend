/**
 * WP-1.11c tests — tool definitions, gating matrix, budget mapping, outputs.
 */
import { describe, it, expect } from "vitest";
import { createRemoteTools } from "./remote-tools.js";
import { capsToBudget } from "./budget.js";
import { perModelFallback, estimateCost } from "./cost-preview.js";
import type { ManagedApiClient } from "../api-client.js";
import type { PiManagedSettings } from "../config.js";
import path from "node:path";

function makeSettings(over: Partial<PiManagedSettings> = {}): PiManagedSettings {
  return {
    backendUrl: "https://api.example.com",
    apiKeyRef: "ref",
    delegationPolicy: "confirm",
    pollingIntervalMs: 5000,
    streamTimeoutMs: 1_800_000,
    outputsDir: "./.pi-managed/outputs/",
    tenant: "tnt_test",
    ...over,
  } as PiManagedSettings;
}

interface Call {
  method: string;
  args: unknown[];
}

function makeClient(over: Partial<ManagedApiClient> = {}): { client: ManagedApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    createSession: (body: unknown) => {
      calls.push({ method: "createSession", args: [body] });
      return Promise.resolve({
        id: "sess_1",
        status: "idle",
        stopReason: null,
        agentId: "agent_1",
        agentVersion: 1,
        environmentId: "env_1",
        title: body.title ?? "",
        budget: body.budget,
        usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        vaultIds: [],
        resources: [],
        metadata: {},
        createdAt: "2026-07-13T12:00:00Z",
        updatedAt: "2026-07-13T12:00:00Z",
        lastActivityAt: "2026-07-13T12:00:00Z",
        forkedFromSessionId: null,
      });
    },
    sendEvent: (id: string, ev: unknown) => {
      calls.push({ method: "sendEvent", args: [id, ev] });
      return Promise.resolve();
    },
    getSession: (id: string) =>
      Promise.resolve(
        over.getSession
          ? (over as unknown).getSession(id)
          : {
              id,
              status: "idle",
              stopReason: null,
              agentId: "a",
              agentVersion: 1,
              environmentId: "e",
              title: "",
              budget: undefined,
              usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
              vaultIds: [],
              resources: [],
              metadata: {},
              createdAt: "",
              updatedAt: "",
              lastActivityAt: "",
              forkedFromSessionId: null,
            },
      ),
    getSessionUsage: () =>
      Promise.resolve({ inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, usdCost: 0.01 }),
    listSessions: () => Promise.resolve({ data: [], nextCursor: null }),
    forkSession: (id: string) =>
      Promise.resolve({
        id: "sess_2",
        status: "idle",
        stopReason: null,
        agentId: "a",
        agentVersion: 1,
        environmentId: "e",
        title: "",
        budget: undefined,
        usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        vaultIds: [],
        resources: [],
        metadata: {},
        createdAt: "",
        updatedAt: "",
        lastActivityAt: "",
        forkedFromSessionId: id,
      }),
    fetchJson: () => Promise.resolve({ data: [{ name: "out.txt" }] }),
    downloadFile: (p: string, localPath: string) => {
      calls.push({ method: "downloadFile", args: [p, localPath] });
      return Promise.resolve();
    },
    ...over,
  } as unknown as ManagedApiClient;
  return { client, calls };
}

function makeTools(settings: PiManagedSettings, clientOver: Partial<ManagedApiClient> = {}) {
  const { client, calls } = makeClient(clientOver);
  const opts = {
    client: () => client,
    settings: () => settings,
    confirm: async () => true,
    notice: () => {},
    resolveOutputPath: (sid: string, fn: string) => path.join("/tmp/out", sid, fn),
  };
  return { tools: createRemoteTools(opts), calls };
}

describe("WP-1.11c remote tools", () => {
  it("defines all 7 tools with detailed descriptions (>200 chars)", () => {
    const { tools } = makeTools(makeSettings());
    expect(tools).toHaveLength(7);
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(200);
      expect(t.name).toMatch(/^remote_/);
    }
  });

  it("remote_delegate creates a session with budget from spend caps", async () => {
    const { tools, calls } = makeTools(
      makeSettings({ spendCapPerSession: 2.5, defaultAgent: "agent_1", defaultEnvironment: "env_1" }),
    );
    const delegate = tools.find((t) => t.name === "remote_delegate")!;
    const res = await delegate.execute("tc1", { task: "run tests" }, undefined, undefined, undefined as unknown);
    expect(res.details).toMatchObject({ sessionId: "sess_1", costEstimate: expect.any(Number) });
    const createCall = calls.find((c) => c.method === "createSession");
    expect(createCall?.args[0]).toMatchObject({ budget: { maxUsd: 2.5 } });
  });

  it("remote_read_outputs fetches files to local paths (idle only)", async () => {
    const { tools, calls } = makeTools(makeSettings());
    const read = tools.find((t) => t.name === "remote_read_outputs")!;
    const res = await read.execute("tc1", { sessionId: "sess_1" }, undefined, undefined, undefined as unknown);
    expect(res.details).toMatchObject({ paths: [path.join("/tmp/out", "sess_1", "out.txt")] });
    expect(calls.some((c) => c.method === "downloadFile")).toBe(true);
  });

  it("remote_read_outputs rejects when session is not idle", async () => {
    const { tools } = makeTools(
      makeSettings(),
      { getSession: () => Promise.resolve({ status: "running" } as unknown) },
    );
    const read = tools.find((t) => t.name === "remote_read_outputs")!;
    await expect(read.execute("tc1", { sessionId: "sess_1" }, undefined, undefined, undefined as unknown)).rejects.toThrow(/idle/);
  });

  it("capsToBudget maps spendCapPerSession → maxUsd", () => {
    expect(capsToBudget(makeSettings({ spendCapPerSession: 3 }))).toEqual({ maxUsd: 3 });
    expect(capsToBudget(makeSettings({ spendCapPerSession: undefined }))).toBeUndefined();
  });

  it("perModelFallback returns a number for known + unknown models", () => {
    expect(perModelFallback("anthropic/claude-sonnet-4")).toBeGreaterThan(0);
    expect(perModelFallback(undefined)).toBeGreaterThan(0);
    expect(perModelFallback("unknown/model")).toBeGreaterThan(0);
  });

  it("estimateCost returns a labeled estimate", async () => {
    const est = await estimateCost({} as ManagedApiClient, "agent_1", makeSettings());
    expect(est).toBeGreaterThan(0);
  });
});
