/**
 * Permission-gate extension + policy tests (WP-2.3, §9.5 / §22 / §29.3).
 *
 * Covers:
 * - Built-ins default `always_allow` (not gated).
 * - MCP tools default `always_ask` (gated).
 * - Per-tool `always_ask` override is honored.
 * - Running sessions keep creation-time config (§22.2) — snapshot is independent of
 *   later mutation.
 * - The `tool_call` hook round-trip: allow → returns void (Pi runs the tool); deny →
 *   returns `{block: true, reason: denyMessage}` (rejection tool result, §9.5).
 * - Multi-blocking-event end-to-end through the hook + coordinator.
 */

import { describe, expect, it } from "vitest";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import {
  ConfirmationCoordinator,
  type ConfirmationCoordinatorHooks,
} from "../confirmation.js";
import { createPermissionGate, onToolCall } from "../index.js";
import {
  isAlwaysAsk,
  isAlwaysDeny,
  isBuiltInTool,
  resolvePermissionPolicy,
  snapshotToolsetConfig,
} from "../policy.js";
import type { ToolsetConfig } from "../../../domain/toolset/config.js";

function fakeHooks(): { hooks: ConfirmationCoordinatorHooks; ids: string[][] } {
  const ids: string[][] = [];
  return {
    hooks: { emitStatusIdleRequiresAction: (x) => ids.push([...x]) },
    ids,
  };
}

function toolCall(
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown> = {},
): ToolCallEvent {
  return {
    type: "tool_call",
    toolCallId,
    toolName: toolName as never,
    input,
  } as ToolCallEvent;
}

const BUILTIN_DEFAULT: ToolsetConfig = {
  defaultConfig: { enabled: true, permissionPolicy: "always_allow" },
};

const BASH_ASK: ToolsetConfig = {
  defaultConfig: { enabled: true, permissionPolicy: "always_allow" },
  configs: { bash: { enabled: true, permissionPolicy: "always_ask" } },
};

const BASH_DENY: ToolsetConfig = {
  defaultConfig: { enabled: true, permissionPolicy: "always_allow" },
  configs: { bash: { enabled: true, permissionPolicy: "always_deny" } },
};

describe("policy resolution (§22.1 / §22.2)", () => {
  it("built-ins default to always_allow", () => {
    const snap = snapshotToolsetConfig(BUILTIN_DEFAULT);
    expect(resolvePermissionPolicy(snap, "bash")).toBe("always_allow");
    expect(isAlwaysAsk(snap, "bash")).toBe(false);
    expect(isAlwaysAsk(snap, "read")).toBe(false);
  });

  it("MCP tools (non-builtin names) default to always_ask", () => {
    const snap = snapshotToolsetConfig(BUILTIN_DEFAULT);
    expect(resolvePermissionPolicy(snap, "github_create_pr", false)).toBe("always_ask");
    expect(isAlwaysAsk(snap, "github_create_pr")).toBe(true);
  });

  it("isMcp=true forces the MCP default even for a builtin-named tool", () => {
    const snap = snapshotToolsetConfig(BUILTIN_DEFAULT);
    expect(resolvePermissionPolicy(snap, "bash", true)).toBe("always_ask");
    expect(isAlwaysAsk(snap, "bash", true)).toBe(true);
  });

  it("per-tool always_ask override is honored", () => {
    const snap = snapshotToolsetConfig(BASH_ASK);
    expect(isAlwaysAsk(snap, "bash")).toBe(true);
    expect(isAlwaysAsk(snap, "read")).toBe(false); // unaffected
  });

  it("snapshot is independent of later mutation (§22.2)", () => {
    const live: ToolsetConfig = {
      defaultConfig: { enabled: true, permissionPolicy: "always_allow" },
    };
    const snap = snapshotToolsetConfig(live);
    // Mutate the live config after snapshot — the snapshot's view must not change.
    live.defaultConfig = { enabled: true, permissionPolicy: "always_ask" };
    expect(resolvePermissionPolicy(snap, "bash")).toBe("always_allow");
  });

  it("isBuiltInTool recognizes the nine built-ins", () => {
    expect(isBuiltInTool("bash")).toBe(true);
    expect(isBuiltInTool("web_search")).toBe(true);
    expect(isBuiltInTool("github_create_pr")).toBe(false);
  });

  it("always_deny is recognized as a hard block, not an ask (SEC-5)", () => {
    const snap = snapshotToolsetConfig(BASH_DENY);
    expect(resolvePermissionPolicy(snap, "bash")).toBe("always_deny");
    expect(isAlwaysDeny(snap, "bash")).toBe(true);
    expect(isAlwaysAsk(snap, "bash")).toBe(false);
    // A tool without the deny override is unaffected.
    expect(isAlwaysDeny(snap, "read")).toBe(false);
  });
});

describe("onToolCall hook (§9.5)", () => {
  it("does not gate an always_allow built-in (returns void, no confirmation)", async () => {
    const { hooks, ids } = fakeHooks();
    const coord = new ConfirmationCoordinator(hooks);
    const snap = snapshotToolsetConfig(BUILTIN_DEFAULT);
    const result = await onToolCall(toolCall("t1", "bash"), snap, coord);
    expect(result).toBeUndefined();
    expect(coord.pendingCount).toBe(0);
    expect(ids).toEqual([]);
  });

  it("always_deny hard-blocks with no confirmation round-trip (SEC-5)", async () => {
    const { hooks, ids } = fakeHooks();
    const coord = new ConfirmationCoordinator(hooks);
    const snap = snapshotToolsetConfig(BASH_DENY);

    const result = await onToolCall(toolCall("evt_deny_hard", "bash"), snap, coord);
    expect(result).toEqual({
      block: true,
      reason: 'Tool "bash" is blocked by permission policy (always_deny)',
    });
    // No confirmation was requested and nothing was advertised as blocking.
    expect(coord.pendingCount).toBe(0);
    expect(ids).toEqual([]);
  });

  it("allow round-trip: blocks, emits requires_action, then resumes (void result)", async () => {
    const { hooks, ids } = fakeHooks();
    const coord = new ConfirmationCoordinator(hooks);
    const snap = snapshotToolsetConfig(BASH_ASK);

    const pending = onToolCall(toolCall("evt_allow", "bash"), snap, coord);
    // While pending, the coordinator advertised the blocking id.
    expect(ids).toEqual([["evt_allow"]]);
    expect(coord.pendingCount).toBe(1);

    // User allows → hook resolves to void (Pi proceeds).
    coord.applyConfirmation("evt_allow", "allow");
    await expect(pending).resolves.toBeUndefined();
    expect(coord.pendingCount).toBe(0);
  });

  it("deny round-trip: returns {block:true, reason: denyMessage}", async () => {
    const { hooks } = fakeHooks();
    const coord = new ConfirmationCoordinator(hooks);
    const snap = snapshotToolsetConfig(BASH_ASK);

    const pending = onToolCall(toolCall("evt_deny", "bash"), snap, coord);
    coord.applyConfirmation("evt_deny", "deny", "Forbidden by policy");
    await expect(pending).resolves.toEqual({
      block: true,
      reason: "Forbidden by policy",
    });
  });

  it("deny without message returns the default rejection reason", async () => {
    const { hooks } = fakeHooks();
    const coord = new ConfirmationCoordinator(hooks);
    const snap = snapshotToolsetConfig(BASH_ASK);
    const pending = onToolCall(toolCall("evt_d2", "bash"), snap, coord);
    coord.applyConfirmation("evt_d2", "deny");
    const result = await pending;
    expect(result).toEqual({ block: true, reason: "Tool call denied by user" });
  });

  it("MCP tool (non-builtin name) is gated under the builtin-default config", async () => {
    const { hooks, ids } = fakeHooks();
    const coord = new ConfirmationCoordinator(hooks);
    const snap = snapshotToolsetConfig(BUILTIN_DEFAULT);
    const pending = onToolCall(
      toolCall("evt_mcp", "github_create_pr", { repo: "x" }),
      snap,
      coord,
    );
    expect(ids).toEqual([["evt_mcp"]]);
    coord.applyConfirmation("evt_mcp", "allow");
    await expect(pending).resolves.toBeUndefined();
  });

  it("multi-blocking-event: two always_ask tools block, each confirmed in turn", async () => {
    // bash is always_ask (override) and an MCP tool is always_ask by default.
    const { hooks, ids } = fakeHooks();
    const coord = new ConfirmationCoordinator(hooks);
    const snap = snapshotToolsetConfig(BASH_ASK);

    const a = onToolCall(toolCall("evt_A", "bash"), snap, coord);
    const b = onToolCall(
      toolCall("evt_B", "github_create_pr"),
      snap,
      coord,
    );

    // Both blocking ids advertised (second emission includes both pending).
    expect(ids).toEqual([["evt_A"], ["evt_A", "evt_B"]]);

    // Confirm A (allow) → A resumes; B still pending → re-emits [B].
    coord.applyConfirmation("evt_A", "allow");
    await expect(a).resolves.toBeUndefined();
    expect(ids[ids.length - 1]).toEqual(["evt_B"]);

    // Confirm B (deny) → block reason.
    coord.applyConfirmation("evt_B", "deny", "Blocked");
    await expect(b).resolves.toEqual({ block: true, reason: "Blocked" });
    expect(coord.pendingCount).toBe(0);
  });
});

describe("createPermissionGate factory", () => {
  it("registers a tool_call handler that gates always_ask tools", async () => {
    const { hooks, ids } = fakeHooks();
    const coord = new ConfirmationCoordinator(hooks);
    const snap = snapshotToolsetConfig(BASH_ASK);

    let registered: { event: string; handler: (e: ToolCallEvent) => Promise<unknown> } | undefined;
    const fakeApi = {
      on(event: string, handler: (e: ToolCallEvent) => Promise<unknown>) {
        registered = { event, handler };
      },
    } as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;

    const factory = createPermissionGate({ snapshot: snap, coordinator: coord });
    factory(fakeApi);
    expect(registered?.event).toBe("tool_call");

    const pending = registered!.handler(toolCall("evt_f", "bash"));
    expect(ids).toEqual([["evt_f"]]);
    coord.applyConfirmation("evt_f", "deny", "No");
    await expect(pending).resolves.toEqual({ block: true, reason: "No" });
  });
});
