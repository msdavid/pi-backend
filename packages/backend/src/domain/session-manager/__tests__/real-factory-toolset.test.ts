/**
 * R1.1 — the honest harness instrument.
 *
 * Drives the REAL {@link PiAgentSessionFactory} (materialize.ts) and asserts on the
 * options it hands to Pi's `createAgentSession`. The Pi SDK is mocked so `createAgentSession`
 * is a spy (no model key / network required) and `ModelRegistry.inMemory().find()` returns a
 * found model. The `customTools` come from a REAL `materializeToolset` over a fake
 * provider+handle, wrapped by the production `toCustomToolDefinitions` path.
 *
 * This test is RED before R2.2 (the real factory passed neither `noTools` nor the sandbox
 * toolset, so Pi's default host-executing built-ins ran) and GREEN after: `noTools:"builtin"`
 * suppresses the built-ins and the 9 sandbox-bound tools arrive as `customTools`.
 */

import { describe, expect, it, vi } from "vitest";

// --- Mock the Pi SDK: createAgentSession is a spy; the rest are minimal doubles. ---
// (hoisted so the spy exists when the hoisted vi.mock factory runs)
const { createAgentSessionSpy } = vi.hoisted(() => ({
  createAgentSessionSpy: vi.fn(async () => ({
    session: {
      sessionId: "sess_real",
      sessionFile: undefined,
      isStreaming: false,
      prompt: async () => {},
      steer: async () => {},
      followUp: async () => {},
      subscribe: () => () => {},
      abort: async () => {},
      dispose: () => {},
      sessionManager: { getEntries: () => [] },
    },
  })),
}));

vi.mock("@earendil-works/pi-coding-agent", () => {
  class DefaultResourceLoader {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_opts: any) {}
    async reload() {}
  }
  const noop = vi.fn(() => ({}));
  return {
    createAgentSession: createAgentSessionSpy,
    AuthStorage: { inMemory: vi.fn(() => ({})) },
    ModelRegistry: {
      inMemory: vi.fn(() => ({
        find: (provider: string, id: string) => ({ provider, id }),
      })),
    },
    SettingsManager: { inMemory: vi.fn(() => ({})) },
    SessionManager: {
      open: vi.fn(() => ({ setSessionFile: vi.fn() })),
      create: vi.fn(() => ({ setSessionFile: vi.fn() })),
    },
    DefaultResourceLoader,
    defineTool: <T>(tool: T): T => tool,
    // Referenced by sandbox-toolset's defaultRemoteToolFactories at import time.
    createBashTool: noop,
    createReadTool: noop,
    createWriteTool: noop,
    createEditTool: noop,
    createFindTool: noop,
    createLsTool: noop,
  };
});

import type { AgentConfig } from "@pi-managed/contracts";
import type { SandboxHandle, SandboxProvider } from "../../ports.js";
import { PiAgentSessionFactory } from "../materialize.js";
import { toCustomToolDefinitions } from "../sandbox-toolset.js";
import { materializeToolset } from "../../toolset/index.js";
import type { RemoteToolFactories } from "../operations/tool-factory.js";

const SANDBOX_TOOLS = [
  "bash",
  "read",
  "write",
  "edit",
  "find",
  "ls",
  "grep",
  "web_fetch",
  "web_search",
].sort();

/** Fake Pi tool factories: each returns a named sentinel (no host execution). */
function fakeFactories(): RemoteToolFactories {
  const mk = (name: string) => () => ({ name });
  return {
    createBashTool: mk("bash"),
    createReadTool: mk("read"),
    createWriteTool: mk("write"),
    createEditTool: mk("edit"),
    createFindTool: mk("find"),
    createLsTool: mk("ls"),
  };
}

function fakeProvider(): SandboxProvider {
  return {
    async exec() {
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  } as unknown as SandboxProvider;
}

describe("PiAgentSessionFactory — real factory toolset (R1.1)", () => {
  it("passes noTools:'builtin' and the 9 sandbox-bound tools as customTools", async () => {
    const handle: SandboxHandle = {
      id: "h",
      name: "h",
      labels: { tenant: "t", session: "s" },
    };
    // Real materializeToolset over a fake provider+handle → the 9 tools map.
    const toolset = materializeToolset(
      { provider: fakeProvider(), handle, cwd: "/workspace", factories: fakeFactories() },
      undefined,
    );
    const customTools = toCustomToolDefinitions(toolset.tools);

    const material = {
      agentConfig: {
        model: { provider: "anthropic", id: "claude-sonnet-4-5" },
      } as AgentConfig,
      providerKeys: { anthropic: "sk-not-a-real-key" },
      cwd: "/workspace",
      customTools,
    };

    const factory = new PiAgentSessionFactory();
    await factory.create({
      material,
      localJsonlPath: "/tmp/pi-r11-does-not-exist/log.jsonl",
    });

    expect(createAgentSessionSpy).toHaveBeenCalledTimes(1);
    const options = createAgentSessionSpy.mock.calls[0]![0] as {
      noTools?: string;
      customTools?: Array<{ name: string }>;
    };

    // R2.2: the host-executing built-ins are suppressed.
    expect(options.noTools).toBe("builtin");

    // R2.1: exactly the 9 sandbox-bound tools are supplied.
    expect(options.customTools).toHaveLength(9);
    expect((options.customTools ?? []).map((t) => t.name).sort()).toEqual(
      SANDBOX_TOOLS,
    );
  });

  it("refuses to construct a session with zero sandbox tools (§10.2 host-lockout guard)", async () => {
    // A material with no customTools means the sandbox toolset was never materialized at
    // wake — with `noTools:"builtin"` that would be a tool-less session, and the guard must
    // reject it (a wiring bug that would otherwise ship a silently-degraded agent). This
    // guard was implemented but untested before the audit-fix pass.
    const material = {
      agentConfig: {
        model: { provider: "anthropic", id: "claude-sonnet-4-5" },
      } as AgentConfig,
      providerKeys: { anthropic: "sk-not-a-real-key" },
      cwd: "/workspace",
      customTools: [],
    };
    createAgentSessionSpy.mockClear();
    const factory = new PiAgentSessionFactory();
    await expect(
      factory.create({
        material,
        localJsonlPath: "/tmp/pi-r11-does-not-exist/log.jsonl",
      }),
    ).rejects.toThrow(/zero sandbox/i);
    // The guard fires BEFORE any model session is constructed.
    expect(createAgentSessionSpy).not.toHaveBeenCalled();
  });
});
