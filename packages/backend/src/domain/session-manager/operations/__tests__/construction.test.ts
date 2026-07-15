/**
 * Construction-time completeness guard tests (WP-1.4, spec §10.2 / §29.2).
 *
 * A default-ops tool executes on the backend host = sandbox escape. The factory
 * asserts every Pi-backed tool receives a remote `Operations` object, and `user_bash`
 * (the other host-executing path) is disabled.
 */

import { describe, expect, it } from "vitest";
import {
  assertRemoteOperations,
  createRemoteTools,
  disableUserBash,
  type RemoteToolFactories,
} from "../tool-factory.js";
import type { SandboxHandle, SandboxProvider } from "../../../../ports.js";

/** Minimal no-op provider (the factory does not exec at construction time). */
function noopProvider(): SandboxProvider {
  const p = {
    async provision() {
      return {} as SandboxHandle;
    },
    async exec() {
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async *execStream() {},
    async stop() {},
    async start() {},
    async snapshot() {
      return "snap";
    },
    async destroy() {},
    async reattachByLabels() {
      return [];
    },
    async status() {
      return "running" as const;
    },
    async registerSecretBinding() {},
  };
  return p as unknown as SandboxProvider;
}

describe("construction guard: assertRemoteOperations", () => {
  it("throws when ops is undefined (default-ops = sandbox escape)", () => {
    expect(() => assertRemoteOperations("bash", undefined)).toThrow(/§10.2/);
    expect(() => assertRemoteOperations("bash", null)).toThrow(/completeness/);
  });

  it("returns the ops object when defined", () => {
    const ops = { exec: () => Promise.resolve({ exitCode: 0 }) };
    expect(assertRemoteOperations("bash", ops)).toBe(ops);
  });
});

describe("construction guard: createRemoteTools", () => {
  it("passes a remote Operations object to every Pi tool factory", () => {
    const seen: Record<string, unknown> = {};
    const factories: RemoteToolFactories = {
      createBashTool: (_cwd, o) => ((seen.bash = o.operations), { name: "bash" }),
      createReadTool: (_cwd, o) => ((seen.read = o.operations), { name: "read" }),
      createWriteTool: (_cwd, o) => ((seen.write = o.operations), { name: "write" }),
      createEditTool: (_cwd, o) => ((seen.edit = o.operations), { name: "edit" }),
      createFindTool: (_cwd, o) => ((seen.find = o.operations), { name: "find" }),
      createLsTool: (_cwd, o) => ((seen.ls = o.operations), { name: "ls" }),
    };
    const handle: SandboxHandle = {
      id: "h",
      name: "h",
      labels: { tenant: "t", session: "s" },
    };
    const { tools, operations, userBashDisabled } = createRemoteTools({
      provider: noopProvider(),
      handle,
      cwd: "/work",
      factories,
    });
    // Every factory received the SAME remote-ops bundle (not a default).
    expect(seen.bash).toBe(operations.bash);
    expect(seen.read).toBe(operations.read);
    expect(seen.write).toBe(operations.write);
    expect(seen.edit).toBe(operations.edit);
    expect(seen.find).toBe(operations.find);
    expect(seen.ls).toBe(operations.ls);
    // All nine tools are present (7 built-ins + web_fetch + web_search).
    for (const name of [
      "bash",
      "read",
      "write",
      "edit",
      "find",
      "ls",
      "grep",
      "web_fetch",
      "web_search",
    ]) {
      expect(tools[name]).toBeDefined();
    }
    expect(userBashDisabled).toBe(true);
  });

  it("grep is the custom remote tool (not a host-executing default)", () => {
    const factories: RemoteToolFactories = {
      createBashTool: () => ({ name: "bash" }),
      createReadTool: () => ({ name: "read" }),
      createWriteTool: () => ({ name: "write" }),
      createEditTool: () => ({ name: "edit" }),
      createFindTool: () => ({ name: "find" }),
      createLsTool: () => ({ name: "ls" }),
    };
    const handle: SandboxHandle = {
      id: "h",
      name: "h",
      labels: { tenant: "t", session: "s" },
    };
    const { tools } = createRemoteTools({
      provider: noopProvider(),
      handle,
      cwd: "/work",
      factories,
    });
    // grep is a custom tool with an `execute` that runs rg in the VM (no host spawn).
    const grep = tools.grep as { name: string; execute: unknown };
    expect(grep.name).toBe("grep");
    expect(typeof grep.execute).toBe("function");
  });
});

describe("construction guard: disableUserBash", () => {
  it("throws when invoked (host execution refused)", () => {
    const fn = disableUserBash();
    expect(fn).toThrow(/user_bash is disabled/);
  });
});
