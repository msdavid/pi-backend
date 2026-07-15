/**
 * R2.7 — provider-key fail-closed.
 *
 * A managed session whose model provider has no resolved key MUST abort before any model
 * call, so it can never fall through to pi-ai's `process.env` fallback and bill the host's
 * `ANTHROPIC_API_KEY`. We seed a sentinel host key, drive the REAL `PiAgentSessionFactory`
 * with non-empty `customTools` (to clear the §10.2 host-lockout guard) but empty
 * `providerKeys`, and assert: the factory throws a non-retryable auth error, and
 * `createAgentSession` is never called (no model construction ⇒ the host key is never used).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createAgentSessionSpy } = vi.hoisted(() => ({
  createAgentSessionSpy: vi.fn(async () => ({
    session: {
      sessionId: "sess_fc",
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
    createBashTool: noop,
    createReadTool: noop,
    createWriteTool: noop,
    createEditTool: noop,
    createFindTool: noop,
    createLsTool: noop,
  };
});

import type { AgentConfig } from "@pi-managed/contracts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { PiAgentSessionFactory } from "../materialize.js";

describe("PiAgentSessionFactory — provider-key fail-closed (R2.7)", () => {
  beforeEach(() => {
    createAgentSessionSpy.mockClear();
    // A "leaked" host key that must NEVER be used for a tenant session.
    process.env.ANTHROPIC_API_KEY = "sk-host-sentinel-must-not-be-billed";
  });
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("throws a non-retryable auth error and never constructs the session", async () => {
    const material = {
      agentConfig: {
        model: { provider: "anthropic", id: "claude-sonnet-4-5" },
      } as AgentConfig,
      // Empty: no tenant-resolved key for the model provider.
      providerKeys: {} as Record<string, string>,
      cwd: "/workspace",
      // Non-empty so the §10.2 host-lockout guard passes and we reach the key check.
      customTools: [{ name: "bash" }] as unknown as ToolDefinition[],
    };

    const factory = new PiAgentSessionFactory();
    await expect(
      factory.create({
        material,
        localJsonlPath: "/tmp/pi-r27-does-not-exist/log.jsonl",
      }),
    ).rejects.toThrow(/no model-provider API key.*non-retryable|auth/i);

    // No model call was made — the host sentinel key was never reached.
    expect(createAgentSessionSpy).not.toHaveBeenCalled();
  });
});
