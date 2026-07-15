/**
 * R2.1 — material wiring at wake().
 *
 * Proves that `ManagedSessionRuntime.wake()` augments the session material once the live
 * sandbox handle exists: it builds the sandbox toolset (`customTools`), sets the guest
 * `cwd`, and resolves the model-provider keys host-side. Uses a real runtime + a real
 * `FakeSandboxProvider`, with a spy `AgentSessionFactory` that captures the material the
 * factory receives. The Pi SDK is NOT mocked — `materializeToolset` runs the real tool
 * factories against the fake provider, and the tools are wrapped with the real `defineTool`.
 */

import { describe, expect, it } from "vitest";
import type { AgentConfig, Environment } from "@pi-managed/contracts";
import {
  FakeObjectStore,
  FakeSandboxProvider,
  FakeSecretStore,
  FakeUsageRecorder,
} from "@pi-managed/testkit";
import { ManagedSessionRuntime } from "../runtime.js";
import { InMemorySessionStore } from "../session-store.js";
import type { ProviderKeyResolver } from "../../ports.js";
import type { SessionRecord } from "../types.js";
import { FakeAgentSessionFactory } from "./fake-agent-session.js";

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
] as const;

function makeEnvironment(): Environment {
  return {
    id: "env_test",
    name: "test-env",
    type: "cloud",
    status: "active",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    image: "ubuntu:22.04",
    resources: { cpus: 1, memoryMiB: 512 },
    networking: { mode: "unrestricted" },
  };
}

function seededRecord(): SessionRecord {
  return {
    sessionId: "sess_wire",
    tenantId: "tnt_wire",
    localJsonlPath: "/tmp/pi-wire/sess_wire/log.jsonl",
    objectStoreKey: "sessions/sess_wire/log.jsonl",
    // Placeholders as db-session-store would supply them — wake() must overwrite these.
    material: {
      agentConfig: {
        model: { provider: "anthropic", id: "claude-sonnet-4-5" },
      } as AgentConfig,
      providerKeys: {},
      cwd: "/placeholder",
    },
    environment: makeEnvironment(),
    vaultIds: ["vlt_keys"],
  };
}

describe("ManagedSessionRuntime.wake — material wiring (R2.1)", () => {
  it("augments customTools, cwd, and providerKeys from the live handle", async () => {
    const sandbox = new FakeSandboxProvider();
    const factory = new FakeAgentSessionFactory();
    const sessions = new InMemorySessionStore();
    sessions.seed(seededRecord());

    const providerKeyResolver: ProviderKeyResolver = {
      resolveProviderKeys: async (ctx) => {
        // The resolver receives the session's vault ids (R2.7 wiring).
        expect(ctx.vaultIds).toEqual(["vlt_keys"]);
        return { anthropic: "sk-resolved-at-wake" };
      },
    };

    const runtime = new ManagedSessionRuntime({
      sandbox,
      objects: new FakeObjectStore(),
      usage: new FakeUsageRecorder(),
      secrets: new FakeSecretStore(),
      sessions,
      factory,
      providerKeyResolver,
    });

    await runtime.wake("sess_wire");

    expect(factory.optionsLog).toHaveLength(1);
    const material = factory.optionsLog[0]!.material;

    // customTools: the 7 sandbox tools + web_fetch + web_search, all present.
    const toolNames = (material.customTools ?? []).map((t) => t.name).sort();
    expect(toolNames).toEqual([...SANDBOX_TOOLS].sort());

    // cwd: the guest workdir (not the "/placeholder" db-session-store default).
    expect(material.cwd).toBe("/workspace");
    expect(material.cwd).not.toBe("/placeholder");

    // providerKeys: resolved host-side, non-empty.
    expect(Object.keys(material.providerKeys).length).toBeGreaterThan(0);
    expect(material.providerKeys).toEqual({ anthropic: "sk-resolved-at-wake" });

    runtime.dispose();
  });
});
