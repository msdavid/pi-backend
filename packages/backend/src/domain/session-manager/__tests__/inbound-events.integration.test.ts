/**
 * R2.6 — inbound event round-trips (permission gate + custom tools).
 *
 * Proves the runtime turns a blocked tool call into `requires_action` and resumes it on
 * the client round-trip. A fake `AgentSession` whose `prompt()` blocks on the runtime's
 * live coordinator stands in for Pi's `tool_call` hook (the Pi SDK is not mocked — the
 * runtime's confirmation/custom-tool coordinators + the requires_action turn driver are
 * the real code under test):
 *
 * - permission gate: `user.message` → the tool call blocks → turn settles as
 *   `requires_action` with the blocking id → `user.tool_confirmation(allow)` → the turn
 *   resumes and settles `completed`.
 * - custom tools: same shape via `agent.custom_tool_use` → `user.custom_tool_result`.
 *
 * Uses a real `ManagedSessionRuntime` + real `FakeSandboxProvider` (materializes the real
 * sandbox toolset at wake) — no KVM, no model, no DB.
 */

import { describe, it, expect } from "vitest";
import type { AgentConfig, Environment } from "@pi-managed/contracts";
import {
  FakeObjectStore,
  FakeSandboxProvider,
  FakeSecretStore,
  FakeUsageRecorder,
} from "@pi-managed/testkit";
import { ManagedSessionRuntime } from "../runtime.js";
import { InMemorySessionStore } from "../session-store.js";
import type {
  AgentSessionEventLike,
  AgentSessionFactory,
  AgentSessionLike,
  CreateAgentSessionOptions,
  SessionEntryLike,
  SessionRecord,
} from "../types.js";
import type { InboundEvent, OutboundEvent } from "../../ports.js";

// -- fakes -------------------------------------------------------------------

/** A fake session whose `prompt()` runs a caller-installed impl (may block). */
class GatedFakeSession implements AgentSessionLike {
  readonly sessionId = "fake-session";
  readonly sessionFile: string | undefined = undefined;
  isStreaming = false;
  promptImpl: ((text: string) => Promise<void>) | null = null;
  private listeners: Array<(e: AgentSessionEventLike) => void> = [];

  async prompt(text: string): Promise<void> {
    if (this.promptImpl) return this.promptImpl(text);
  }
  steer(): Promise<void> {
    return Promise.resolve();
  }
  followUp(): Promise<void> {
    return Promise.resolve();
  }
  subscribe(l: (e: AgentSessionEventLike) => void): () => void {
    this.listeners.push(l);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== l);
    };
  }
  abort(): Promise<void> {
    return Promise.resolve();
  }
  dispose(): void {
    /* no-op */
  }
  getEntries(): SessionEntryLike[] {
    return [];
  }
}

class GatedFactory implements AgentSessionFactory {
  last!: GatedFakeSession;
  create(_options: CreateAgentSessionOptions): Promise<AgentSessionLike> {
    this.last = new GatedFakeSession();
    return Promise.resolve(this.last);
  }
}

// -- helpers -----------------------------------------------------------------

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
    sessionId: "sess_inbound",
    tenantId: "tnt_inbound",
    localJsonlPath: "/tmp/pi-inbound/sess_inbound/log.jsonl",
    objectStoreKey: "sessions/sess_inbound/log.jsonl",
    material: {
      agentConfig: {
        model: { provider: "anthropic", id: "claude-sonnet-4-5" },
      } as AgentConfig,
      providerKeys: { anthropic: "sk-test" },
      cwd: "/placeholder",
    },
    environment: makeEnvironment(),
    vaultIds: [],
  };
}

async function makeWokenRuntime(): Promise<{
  runtime: ManagedSessionRuntime;
  factory: GatedFactory;
  events: OutboundEvent[];
}> {
  const factory = new GatedFactory();
  const sessions = new InMemorySessionStore();
  sessions.seed(seededRecord());
  const runtime = new ManagedSessionRuntime({
    sandbox: new FakeSandboxProvider(),
    objects: new FakeObjectStore(),
    usage: new FakeUsageRecorder(),
    secrets: new FakeSecretStore(),
    sessions,
    factory,
  });
  await runtime.wake("sess_inbound");

  const events: OutboundEvent[] = [];
  void (async () => {
    for await (const e of runtime.subscribe()) events.push(e);
  })();

  return { runtime, factory, events };
}

function userMessage(content: string): InboundEvent {
  return {
    type: "user.message",
    id: `evt_${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
    payload: { content },
  };
}

/** The last `session.status_idle` event's stopReason + blocking ids. */
function lastIdle(
  events: OutboundEvent[],
): { stopReason?: string; blockingEventIds?: string[] } | undefined {
  const idle = [...events].reverse().find((e) => e.type === "session.status_idle");
  return idle?.payload as { stopReason?: string; blockingEventIds?: string[] };
}

// -- tests -------------------------------------------------------------------

describe("ManagedSessionRuntime — inbound round-trips (R2.6)", () => {
  it("permission gate: blocked tool → requires_action → tool_confirmation(allow) → completed", async () => {
    const { runtime, factory, events } = await makeWokenRuntime();
    const coordinator = runtime.confirmationCoordinator;
    const toolCallId = "tc_bash_1";
    let toolRan = false;

    // The scripted turn blocks on an always_ask confirmation, then "runs" the tool.
    factory.last.promptImpl = async () => {
      const decision = await coordinator.requestConfirmation({
        toolCallId,
        toolName: "bash",
        input: { cmd: "ls" },
        isMcp: false,
      });
      if (decision.allow) toolRan = true;
    };

    // Drive the turn → it settles as requires_action while the tool stays blocked.
    await runtime.sendEvent(userMessage("do it"));
    expect(runtime.status()).toBe("idle");
    const blocked = lastIdle(events);
    expect(blocked?.stopReason).toBe("requires_action");
    expect(blocked?.blockingEventIds).toEqual([toolCallId]);
    expect(toolRan).toBe(false);

    // Confirm → the paused turn resumes and settles completed.
    await runtime.sendEvent({
      type: "user.tool_confirmation",
      id: `evt_${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
      payload: { eventId: toolCallId, decision: "allow" },
    });
    expect(toolRan).toBe(true);
    expect(runtime.status()).toBe("idle");
    expect(lastIdle(events)?.stopReason).toBe("completed");

    runtime.dispose();
  });

  it("permission gate: deny surfaces the decision and still settles the turn", async () => {
    const { runtime, factory, events } = await makeWokenRuntime();
    const coordinator = runtime.confirmationCoordinator;
    const toolCallId = "tc_bash_2";
    let allowed: boolean | undefined;

    factory.last.promptImpl = async () => {
      const decision = await coordinator.requestConfirmation({
        toolCallId,
        toolName: "bash",
        input: {},
        isMcp: false,
      });
      allowed = decision.allow;
    };

    await runtime.sendEvent(userMessage("run bash"));
    expect(lastIdle(events)?.stopReason).toBe("requires_action");

    await runtime.sendEvent({
      type: "user.tool_confirmation",
      id: `evt_${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
      payload: { eventId: toolCallId, decision: "deny", denyMessage: "nope" },
    });
    expect(allowed).toBe(false);
    expect(lastIdle(events)?.stopReason).toBe("completed");

    runtime.dispose();
  });

  it("custom tools: custom_tool_use → requires_action → custom_tool_result → completed", async () => {
    const { runtime, factory, events } = await makeWokenRuntime();
    const relay = runtime.customToolCoordinator;
    let result: string | undefined;

    factory.last.promptImpl = async () => {
      const r = await relay.requestCustomToolUse({
        toolName: "lookup",
        input: { q: "weather" },
      });
      result = r.result;
    };

    await runtime.sendEvent(userMessage("look it up"));
    // The blocking id is the custom_tool_use event id the runtime emitted.
    const useEvent = events.find((e) => e.type === "agent.custom_tool_use");
    expect(useEvent).toBeDefined();
    const customToolUseId = (useEvent!.payload as { customToolUseId: string })
      .customToolUseId;
    const blocked = lastIdle(events);
    expect(blocked?.stopReason).toBe("requires_action");
    expect(blocked?.blockingEventIds).toEqual([customToolUseId]);

    await runtime.sendEvent({
      type: "user.custom_tool_result",
      id: `evt_${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
      payload: { customToolUseId, result: "sunny" },
    });
    expect(result).toBe("sunny");
    expect(runtime.status()).toBe("idle");
    expect(lastIdle(events)?.stopReason).toBe("completed");

    runtime.dispose();
  });
});
