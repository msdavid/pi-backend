/**
 * Custom-tool relay tests (WP-3.4, §9.4 / §11.2 / §22 preamble).
 *
 * Covers: round-trip (agent.custom_tool_use → status_idle requires_action →
 * user.custom_tool_result → running); keyed by customToolUseId (mismatch → still
 * waiting); multiple pending uses; isError propagation; abortAll; the defineTool shim
 * wiring (execute → relay → result content); and that permissions do NOT apply (the
 * shim relays unconditionally with no policy snapshot — §22 preamble).
 *
 * The {@link CustomToolCoordinator} is exercised through a fake emitter that records
 * the `agent.custom_tool_use` + `requires_action` idle signals (the same seam the
 * runtime / events-API layer implements against the live outbound queue).
 */

import { describe, expect, it } from "vitest";
import {
  CustomToolCoordinator,
  type CustomToolUse,
} from "../relay.js";
import {
  buildCustomToolShim,
  createCustomToolsRelay,
  type CustomToolDeclaration,
} from "../index.js";

interface EmittedIdle {
  blockingEventIds: string[];
}

function fakeHooks(): {
  hooks: {
    emitCustomToolUse(use: CustomToolUse): void;
    emitStatusIdleRequiresAction(ids: readonly string[]): void;
  };
  uses: CustomToolUse[];
  emitted: EmittedIdle[];
} {
  const uses: CustomToolUse[] = [];
  const emitted: EmittedIdle[] = [];
  return {
    hooks: {
      emitCustomToolUse: (use) => uses.push(use),
      emitStatusIdleRequiresAction: (ids) =>
        emitted.push({ blockingEventIds: [...ids] }),
    },
    uses,
    emitted,
  };
}

describe("CustomToolCoordinator (round-trip)", () => {
  it("emits agent.custom_tool_use + requires_action (keyed by customToolUseId) and awaits the result", async () => {
    const { hooks, uses, emitted } = fakeHooks();
    const coord = new CustomToolCoordinator(hooks);

    const pending = coord.requestCustomToolUse({
      toolName: "lookup_order",
      input: { orderId: "o_42" },
    });
    expect(coord.pendingCount).toBe(1);
    expect(uses).toHaveLength(1);
    expect(uses[0].toolName).toBe("lookup_order");
    expect(uses[0].input).toEqual({ orderId: "o_42" });

    const id = uses[0].customToolUseId;
    expect(coord.hasPending(id)).toBe(true);
    expect(emitted).toEqual([{ blockingEventIds: [id] }]);
    expect(pending).toBeInstanceOf(Promise);

    // Client responds with user.custom_tool_result keyed by customToolUseId.
    const ok = coord.applyCustomToolResult(id, "Order #42: shipped");
    expect(ok).toBe(true);
    await expect(pending).resolves.toEqual({
      customToolUseId: id,
      result: "Order #42: shipped",
      isError: false,
    });
    expect(coord.pendingCount).toBe(0);
  });

  it("a mismatched customToolUseId leaves the call waiting (still requires_action)", async () => {
    const { hooks, emitted } = fakeHooks();
    const coord = new CustomToolCoordinator(hooks);

    const pending = coord.requestCustomToolUse({ toolName: "t", input: {} });
    const id = "evt_unknown";
    expect(coord.hasPending(id)).toBe(false);

    // Wrong key → no-op.
    const ok = coord.applyCustomToolResult(id, "nope");
    expect(ok).toBe(false);
    expect(coord.pendingCount).toBe(1);
    expect(emitted.length).toBe(1); // only the initial block emission

    // The real id still resolves it.
    const realId = [...coord.pendingEventIds][0];
    coord.applyCustomToolResult(realId, "ok");
    await expect(pending).resolves.toMatchObject({ result: "ok" });
  });

  it("handles multiple pending uses: advertises all ids, answers each in turn", async () => {
    const { hooks, emitted } = fakeHooks();
    const coord = new CustomToolCoordinator(hooks);

    const a = coord.requestCustomToolUse({ toolName: "t_a", input: {} });
    const b = coord.requestCustomToolUse({ toolName: "t_b", input: {} });
    const [idA, idB] = coord.pendingEventIds;

    // First idle advertises A; the second advertises BOTH (pending set grew).
    expect(emitted).toEqual([
      { blockingEventIds: [idA] },
      { blockingEventIds: [idA, idB] },
    ]);

    coord.applyCustomToolResult(idA, "resA");
    await expect(a).resolves.toMatchObject({ result: "resA" });
    expect(coord.pendingEventIds).toEqual([idB]);
    expect(emitted[emitted.length - 1]).toEqual({ blockingEventIds: [idB] });

    coord.applyCustomToolResult(idB, "resB");
    await expect(b).resolves.toMatchObject({ result: "resB" });
    expect(coord.pendingCount).toBe(0);
    // No extra idle emission after the last result (pending set empty).
    expect(emitted.length).toBe(3);
  });

  it("propagates isError from the client result", async () => {
    const { hooks } = fakeHooks();
    const coord = new CustomToolCoordinator(hooks);
    const pending = coord.requestCustomToolUse({ toolName: "t", input: {} });
    const id = [...coord.pendingEventIds][0];
    coord.applyCustomToolResult(id, "tool crashed", true);
    await expect(pending).resolves.toMatchObject({ isError: true, result: "tool crashed" });
  });

  it("abortAll resolves every pending use as an error result", async () => {
    const { hooks } = fakeHooks();
    const coord = new CustomToolCoordinator(hooks);
    const a = coord.requestCustomToolUse({ toolName: "t", input: {} });
    const b = coord.requestCustomToolUse({ toolName: "t", input: {} });
    coord.abortAll("Session interrupted");
    await expect(a).resolves.toMatchObject({ isError: true, result: "Session interrupted" });
    await expect(b).resolves.toMatchObject({ isError: true, result: "Session interrupted" });
    expect(coord.pendingCount).toBe(0);
  });
});

describe("defineTool shim (buildCustomToolShim)", () => {
  const decl: CustomToolDeclaration = {
    name: "lookup_order",
    label: "Lookup Order",
    description: "Look up an order by id (executed by the client).",
    parameters: { type: "object" } as never,
  };

  it("execute relays through the coordinator and returns the result as tool content", async () => {
    const { hooks, uses } = fakeHooks();
    const coord = new CustomToolCoordinator(hooks);
    const shim = buildCustomToolShim(decl, coord);

    const exec = (shim as { execute: (...args: unknown[]) => Promise<unknown> })
      .execute;
    const pending = exec("call_1", { orderId: "o_9" }, undefined, undefined, {});

    // The invocation surfaced as agent.custom_tool_use with the model's params.
    expect(uses).toHaveLength(1);
    expect(uses[0].toolName).toBe("lookup_order");
    expect(uses[0].input).toEqual({ orderId: "o_9" });

    coord.applyCustomToolResult(uses[0].customToolUseId, "Order #9: pending");
    const out = await pending;
    expect(out).toEqual({
      content: [{ type: "text", text: "Order #9: pending" }],
      details: undefined,
    });
  });

  it("registers one tool per declaration via pi.registerTool", () => {
    const { hooks } = fakeHooks();
    const coord = new CustomToolCoordinator(hooks);
    const registered: { name: string }[] = [];
    const fakePi = {
      registerTool: (tool: unknown) =>
        registered.push((tool as { name: string })),
    };
    const factory = createCustomToolsRelay({
      declarations: [
        decl,
        { name: "refund", description: "Refund", parameters: { type: "object" } as never },
      ],
      relay: coord,
    });
    factory(fakePi as never);
    expect(registered.map((t) => t.name)).toEqual(["lookup_order", "refund"]);
  });

  it("permissions do NOT apply: the shim relays with no policy snapshot (§22 preamble)", async () => {
    // Contrast with permission-gate, which consults a PermissionPolicySnapshot and
    // only blocks always_ask tools. The custom-tools shim takes NO policy argument
    // and unconditionally relays every invocation — there is nothing to deny.
    const { hooks, uses } = fakeHooks();
    const coord = new CustomToolCoordinator(hooks);
    const shim = buildCustomToolShim(decl, coord);

    const exec = (shim as { execute: (...args: unknown[]) => Promise<unknown> })
      .execute;
    const pending = exec("call_1", {}, undefined, undefined, {});

    // No confirmation step, no allow/deny: the use is surfaced immediately for the
    // client to fulfill.
    expect(uses).toHaveLength(1);
    expect(coord.pendingCount).toBe(1);

    coord.applyCustomToolResult(uses[0].customToolUseId, "done");
    const out = await pending;
    expect((out as { content: { text: string }[] }).content[0].text).toBe("done");
  });
});
