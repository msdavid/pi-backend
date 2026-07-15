/**
 * Worker unit tests (WP-4.2). Mock backend HTTP — no real server, no `msw`.
 *
 * Covers the done criteria:
 *  - poller claim→execute→postResult round-trip (mock fetch);
 *  - spawn-script hand-off (real tiny executable script, mocked backend);
 *  - webhook-triggered wake (wake() resolves the safety sleep early);
 *  - config + env-var overrides.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  Poller,
  type FetchLike,
  type FetchResponse,
} from "./poller.js";
import { WebhookMode } from "./webhook-mode.js";
import { BuiltinExecutor, SpawnExecutor, type WorkItem } from "./control-levels.js";
import { loadConfig } from "./config.js";

/** A scripted mock backend (fetch-like). Records every call. */
class MockBackend implements FetchLike {
  readonly calls: { url: string; method: string; body?: string; headers: Record<string, string> }[] = [];
  private claimResponses: (WorkItem | null)[] = [];
  private resultStatus = 200;

  /** Queue work-claim responses (null = 204 empty). */
  queueClaims(...items: (WorkItem | null)[]): void {
    this.claimResponses.push(...items);
  }
  setResultStatus(status: number): void {
    this.resultStatus = status;
  }

  async call(input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<FetchResponse> {
    const method = init?.method ?? "GET";
    this.calls.push({
      url: input,
      method,
      body: init?.body,
      headers: { ...(init?.headers ?? {}) },
    });
    if (method === "POST" && input.endsWith("/work-claim")) {
      const next = this.claimResponses.shift() ?? null;
      const status = next === null ? 204 : 200;
      const text = next === null ? "" : JSON.stringify(next);
      return this.resp(status, text);
    }
    if (method === "POST" && input.includes("/work-result")) {
      const text = JSON.stringify({ ok: true });
      return this.resp(this.resultStatus, text);
    }
    return this.resp(404, '{"error":"not mocked"}');
  }

  private resp(status: number, text: string): FetchResponse {
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => text,
      json: async () => JSON.parse(text) as unknown,
    };
  }

  get headers(): (i: number) => Record<string, string> {
    return (i: number) => this.calls[i]?.headers ?? {};
  }
}

const BASE = "https://api.test.example.com";
const ENV_ID = "env_01TEST";
const KEY_ID = "apikey_01TEST";
const KEY = "pmb_live_01TEST_SECRET";

function baseConfig(): ReturnType<typeof loadConfig> {
  return loadConfig({
    backendUrl: BASE,
    environmentId: ENV_ID,
    workerKeyId: KEY_ID,
    workerKey: KEY,
    pollingIntervalMs: 1_000_000, // tests drive ticks manually
    mode: "poll",
    controlLevel: "builtin",
  });
}

function makeItem(toolCalls: unknown[]): WorkItem {
  return {
    id: "work_01TEST",
    sessionId: "sess_01TEST",
    environmentId: ENV_ID,
    status: "claimed",
    workSpec: { config: { toolCalls } },
    results: [],
    claimedBy: KEY_ID,
    claimedAt: "2026-07-13T00:00:00Z",
    queuedAt: "2026-07-13T00:00:00Z",
    completedAt: null,
    stopRequested: null,
    stopRequestedAt: null,
    createdAt: "2026-07-13T00:00:00Z",
    updatedAt: "2026-07-13T00:00:00Z",
  };
}

describe("config + env-var overrides", () => {
  const stash: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const k of [
      "PI_MANAGED_BACKEND_URL",
      "PI_MANAGED_ENVIRONMENT_ID",
      "PI_MANAGED_WORKER_KEY",
      "PI_MANAGED_WORKER_KEY_ID",
      "PI_MANAGED_POLLING_INTERVAL_MS",
      "PI_MANAGED_WORKER_MODE",
      "PI_MANAGED_CONTROL_LEVEL",
      "PI_MANAGED_SPAWN_SCRIPT",
    ]) {
      stash[k] = process.env[k];
    }
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(stash)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("reads overrides from PI_MANAGED_* env vars", () => {
    process.env.PI_MANAGED_BACKEND_URL = "https://env.example.com/";
    process.env.PI_MANAGED_ENVIRONMENT_ID = "env_from_env";
    process.env.PI_MANAGED_WORKER_KEY = "pmb_live_env";
    process.env.PI_MANAGED_WORKER_KEY_ID = "apikey_env";
    process.env.PI_MANAGED_POLLING_INTERVAL_MS = "12345";
    process.env.PI_MANAGED_WORKER_MODE = "webhook";
    process.env.PI_MANAGED_CONTROL_LEVEL = "builtin";
    const cfg = loadConfig();
    expect(cfg.backendUrl).toBe("https://env.example.com"); // trailing slash stripped
    expect(cfg.environmentId).toBe("env_from_env");
    expect(cfg.workerKey).toBe("pmb_live_env");
    expect(cfg.workerKeyId).toBe("apikey_env");
    expect(cfg.pollingIntervalMs).toBe(12345);
    expect(cfg.mode).toBe("webhook");
  });

  it("explicit overrides win over env", () => {
    process.env.PI_MANAGED_POLLING_INTERVAL_MS = "12345";
    const cfg = loadConfig({ pollingIntervalMs: 99 });
    expect(cfg.pollingIntervalMs).toBe(99);
  });

  it("requires spawnScript when controlLevel=spawn", () => {
    expect(() => loadConfig({ controlLevel: "spawn" })).toThrow(/spawnScript/);
  });

  it("rejects missing required fields", () => {
    delete process.env.PI_MANAGED_BACKEND_URL;
    expect(() => loadConfig()).toThrow(/backendUrl/);
  });
});

describe("poller claim→execute→postResult round-trip", () => {
  it("claims a bash item, runs it, posts a user.tool_result event", async () => {
    const backend = new MockBackend();
    backend.queueClaims(makeItem([{ tool: "bash", input: { command: "echo hi" } }]));

    const poller = new Poller(baseConfig(), new BuiltinExecutor(), {
      fetchImpl: (i, init) => backend.call(i, init),
    });

    const claimed = await poller.pollOnce();
    expect(claimed).toBe(true);

    // call 0 = work-claim, call 1 = work-result
    expect(backend.calls).toHaveLength(2);
    const claim = backend.calls[0]!;
    expect(claim.url).toBe(`${BASE}/v1/environments/${ENV_ID}/work-claim`);
    expect(claim.method).toBe("POST");
    expect(claim.headers["Authorization"]).toBe(`Bearer ${KEY}`);

    const result = backend.calls[1]!;
    expect(result.url).toBe(`${BASE}/v1/sessions/sess_01TEST/work-result`);
    expect(result.headers["Idempotency-Key"]).toBeTruthy();
    const body = JSON.parse(result.body!);
    expect(body.type).toBe("user.tool_result");
    expect(body.tool).toBe("bash");
    expect(body.output.exitCode).toBe(0);
    expect(body.output.stdout.trim()).toBe("hi");
  });

  it("returns false on an empty queue (204)", async () => {
    const backend = new MockBackend();
    backend.queueClaims(null); // 204
    const poller = new Poller(baseConfig(), new BuiltinExecutor(), {
      fetchImpl: (i, init) => backend.call(i, init),
    });
    const claimed = await poller.pollOnce();
    expect(claimed).toBe(false);
    expect(backend.calls).toHaveLength(1); // claim only, no result post
  });

  it("skips execution when stopRequested is set", async () => {
    const backend = new MockBackend();
    const item = makeItem([{ tool: "bash", input: { command: "echo nope" } }]);
    item.stopRequested = "clean";
    backend.queueClaims(item);
    const poller = new Poller(baseConfig(), new BuiltinExecutor(), {
      fetchImpl: (i, init) => backend.call(i, init),
    });
    const claimed = await poller.pollOnce();
    expect(claimed).toBe(true);
    expect(backend.calls).toHaveLength(1); // claimed, but no result posted
  });

  it("posts an error result when the tool is unsupported", async () => {
    const backend = new MockBackend();
    backend.queueClaims(makeItem([{ tool: "frobnicate", input: {} }]));
    const poller = new Poller(baseConfig(), new BuiltinExecutor(), {
      fetchImpl: (i, init) => backend.call(i, init),
    });
    await poller.pollOnce();
    const body = JSON.parse(backend.calls[1]!.body!);
    expect(body.tool).toBe("frobnicate");
    expect(body.error).toMatch(/unsupported tool/);
  });
});

describe("spawn-script hand-off", () => {
  const scriptPath = join(tmpdir(), "pi-worker-spawn-test.mjs");
  beforeAll(() => {
    // An executable spawn script: reads {workItem, toolCalls} on stdin, returns
    // {"results":[...]} on stdout. Stages its own "sandbox" (here: a no-op).
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const raw = readFileSync(0, "utf8");
const env = JSON.parse(raw);
const out = { results: env.toolCalls.map((c) => ({ tool: c.tool, output: { echoed: c.input, sandboxed: true } })) };
process.stdout.write(JSON.stringify(out));
`,
    );
    chmodSync(scriptPath, 0o755);
  });
  afterAll(() => {
    rmSync(scriptPath, { force: true });
  });

  it("hands the work item to the spawn script and posts its results", async () => {
    const backend = new MockBackend();
    backend.queueClaims(
      makeItem([
        { tool: "bash", input: { command: "echo a" } },
        { tool: "bash", input: { command: "echo b" } },
      ]),
    );
    const executor = new SpawnExecutor(scriptPath);
    const poller = new Poller(baseConfig(), executor, {
      fetchImpl: (i, init) => backend.call(i, init),
    });

    await poller.pollOnce();

    // Two tool calls → two work-result posts, each sourced from the spawn script.
    const resultCalls = backend.calls.filter((c) => c.url.endsWith("/work-result"));
    expect(resultCalls).toHaveLength(2);
    const bodies = resultCalls.map((c) => JSON.parse(c.body!));
    expect(bodies[0].output.sandboxed).toBe(true);
    expect(bodies[0].output.echoed.command).toBe("echo a");
    expect(bodies[1].output.echoed.command).toBe("echo b");
  });

  it("returns an error result when the spawn script exits non-zero", async () => {
    const badScript = join(tmpdir(), "pi-worker-spawn-bad.sh");
    writeFileSync(badScript, "#!/bin/sh\necho oops >&2\nexit 3\n");
    chmodSync(badScript, 0o755);
    try {
      const backend = new MockBackend();
      backend.queueClaims(makeItem([{ tool: "bash", input: { command: "x" } }]));
      const poller = new Poller(baseConfig(), new SpawnExecutor(badScript), {
        fetchImpl: (i, init) => backend.call(i, init),
      });
      await poller.pollOnce();
      const body = JSON.parse(backend.calls[1]!.body!);
      expect(body.tool).toBe("spawn");
      expect(body.error).toMatch(/exited with code 3/);
    } finally {
      rmSync(badScript, { force: true });
    }
  });
});

describe("webhook-triggered wake", () => {
  afterEach(() => {
    // restore env mutated by config tests in this file
  });

  it("wakes from the safety sleep before the safety interval elapses", async () => {
    const backend = new MockBackend();
    // Every claim returns 204 (no work) — the loop just keeps ticking.
    const cfg = baseConfig();
    cfg.pollingIntervalMs = 1_000_000;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const worker = new WebhookMode(cfg, new BuiltinExecutor(), {
      fetchImpl: (i, init) => backend.call(i, init),
      safetyIntervalMs: 30_000, // long — wake() must beat it
    });

    const controller = new AbortController();
    // Re-create with the abort signal wired in.
    const worker2 = new WebhookMode(cfg, new BuiltinExecutor(), {
      fetchImpl: (i, init) => backend.call(i, init),
      safetyIntervalMs: 30_000,
      signal: controller.signal,
    });

    const start = Date.now();
    const stopped = (async () => worker2.start())();

    // Give the first tick time to run, then wake it out of the safety sleep.
    await new Promise((r) => setTimeout(r, 50));
    worker2.wake();
    await new Promise((r) => setTimeout(r, 50));
    worker2.wake(); // a second wake to drive a 3rd tick
    await new Promise((r) => setTimeout(r, 50));

    controller.abort();
    await stopped;
    const elapsed = Date.now() - start;

    // We should have done >= 3 claim ticks in well under the 30s safety interval.
    const claimCalls = backend.calls.filter((c) => c.url.endsWith("/work-claim"));
    expect(claimCalls.length).toBeGreaterThanOrEqual(3);
    expect(elapsed).toBeLessThan(5_000);
  });
});
