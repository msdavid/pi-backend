/**
 * GATE-1 / §29.2 — Host-escape test (WP-1.14).
 *
 * Re-runs WP-1.4's seven-tool host-escape suite against the **assembled** tool
 * factory (`createRemoteTools` + `materializeToolset`). For each of the seven
 * built-in tools a side-effecting call lands **in the VM** (the fake provider's
 * simulated filesystem) and is **absent on the backend host** (the test process's
 * real filesystem). A default-ops tool would execute on the host; this asserts
 * the construction-time completeness guard (`assertRemoteOperations`) wired every
 * tool to remote operations — the §10.2 invariant.
 *
 * Uses a compact VM fake (mirrors `operations/__tests__/host-escape.test.ts`) so the
 * suite runs on every host (no KVM required). The real `MicrosandboxProvider`
 * path is exercised end-to-end by the `@kvm` credential-injection + load gate
 * tests; this test pins the tool-wiring invariant deterministically.
 */

import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  ExecChunk,
  ExecOptions,
  ExecResult,
  ProvisionSpec,
  SandboxHandle,
  SandboxProvider,
  SandboxStatus,
  SnapshotId,
} from "../../src/domain/ports.js";
import { createRemoteOperations } from "../../src/domain/session-manager/operations/remote-operations.js";
import {
  assertRemoteOperations,
  createRemoteTools,
  type RemoteToolFactories,
} from "../../src/domain/session-manager/operations/tool-factory.js";
import { materializeToolset } from "../../src/domain/toolset/materialize.js";

// ---------------------------------------------------------------------------
// Test-only VM fake: simulates a microVM filesystem as a Map (see WP-1.4 test).
// ---------------------------------------------------------------------------

class VmFakeProvider implements SandboxProvider {
  readonly fs = new Map<string, string>();
  readonly dirs = new Set<string>();
  readonly execCalls: string[] = [];

  async provision(spec: ProvisionSpec): Promise<SandboxHandle> {
    return { id: spec.name, name: spec.name, labels: spec.labels };
  }
  async exec(handle: SandboxHandle, opts: ExecOptions): Promise<ExecResult> {
    const cmd = typeof opts.cmd === "string" ? opts.cmd : opts.cmd.join(" ");
    this.execCalls.push(cmd);
    return this.interpret(cmd);
  }
  async *execStream(handle: SandboxHandle, opts: ExecOptions): AsyncIterable<ExecChunk> {
    const cmd = typeof opts.cmd === "string" ? opts.cmd : opts.cmd.join(" ");
    this.execCalls.push(cmd);
    const split = cmd.split("\nprintf");
    const userCmd = split[0] ?? cmd;
    const markerMatch = cmd.match(/__PI_EXIT_[a-z0-9]+__/);
    const result = this.interpret(userCmd);
    if (result.stdout) yield { stream: "stdout", data: result.stdout };
    if (result.stderr && !markerMatch) yield { stream: "stderr", data: result.stderr };
    if (markerMatch) {
      yield { stream: "stderr", data: `\n${markerMatch[0]}${result.exitCode}\n` };
    }
  }
  async stop(): Promise<void> {}
  async start(): Promise<void> {}
  async snapshot(): Promise<SnapshotId> {
    return "snap";
  }
  async destroy(): Promise<void> {}
  async reattachByLabels(): Promise<SandboxHandle[]> {
    return [];
  }
  async status(): Promise<SandboxStatus> {
    return "running";
  }
  async registerSecretBinding(): Promise<void> {}

  private interpret(cmd: string): ExecResult {
    const m = (re: RegExp) => cmd.match(re);
    let r = m(/^base64 -w0 '([^']*)'$/);
    if (r) {
      const v = this.fs.get(r[1]);
      if (v === undefined) return { stdout: "", stderr: "", exitCode: 1 };
      return { stdout: Buffer.from(v, "utf8").toString("base64"), stderr: "", exitCode: 0 };
    }
    r = m(/^test -([rde]) '([^']*)'$/);
    if (r) {
      const path = r[2];
      const exists = this.fs.has(path) || this.dirs.has(path);
      if (r[1] === "d") return { stdout: "", stderr: "", exitCode: this.dirs.has(path) ? 0 : 1 };
      return { stdout: "", stderr: "", exitCode: exists ? 0 : 1 };
    }
    r = m(/^printf %s '([^']*)' \| base64 -d > '([^']*)'$/);
    if (r) {
      this.fs.set(r[2], Buffer.from(r[1], "base64").toString("utf8"));
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    r = m(/^mkdir -p '([^']*)'$/);
    if (r) {
      this.dirs.add(r[1]);
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    r = m(/^cat '([^']*)'$/);
    if (r) {
      const v = this.fs.get(r[1]);
      if (v === undefined) return { stdout: "", stderr: "", exitCode: 1 };
      return { stdout: v, stderr: "", exitCode: 0 };
    }
    r = m(/^file --mime-type -b '([^']*)'$/);
    if (r) {
      if (this.fs.has(r[1])) return { stdout: "text/plain", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 1 };
    }
    r = m(/^stat -c %F '([^']*)'$/);
    if (r) {
      if (this.dirs.has(r[1])) return { stdout: "directory", stderr: "", exitCode: 0 };
      if (this.fs.has(r[1])) return { stdout: "regular file", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 1 };
    }
    r = m(/^ls -A '([^']*)'$/);
    if (r) {
      const dir = r[1].replace(/\/$/, "");
      const entries = new Set<string>();
      for (const k of this.fs.keys()) {
        if (k.startsWith(dir + "/")) {
          const rest = k.slice(dir.length + 1);
          const first = rest.split("/")[0];
          if (first) entries.add(first);
        }
      }
      return { stdout: [...entries].join("\n"), stderr: "", exitCode: 0 };
    }
    r = m(/^fd\b.*'--'\s+'([^']*)'\s+'([^']*)'\s*$/);
    if (r) {
      const cwd = r[2];
      const matches = [...this.fs.keys()].filter((k) => k.startsWith(cwd + "/") || k === cwd);
      return { stdout: matches.join("\n"), stderr: "", exitCode: matches.length ? 0 : 1 };
    }
    r = m(/^rg\b.*'--'\s+'([^']*)'\s+'([^']*)'\s*$/);
    if (r) {
      const pattern = r[1];
      const searchPath = r[2];
      const re = new RegExp(escapeRegex(pattern));
      const lines: string[] = [];
      for (const [path, content] of this.fs) {
        if (searchPath !== path && !path.startsWith(searchPath + "/")) continue;
        content.split("\n").forEach((line, i) => {
          if (re.test(line)) lines.push(`${path}:${i + 1}: ${line}`);
        });
      }
      return { stdout: lines.join("\n"), stderr: "", exitCode: lines.length ? 0 : 1 };
    }
    r = m(/^echo '([^']*)' > '([^']*)'$/);
    if (r) {
      this.fs.set(r[2], r[1]);
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    r = m(/^echo '([^']*)'$/);
    if (r) {
      return { stdout: `${r[1]}\n`, stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function setup() {
  const provider = new VmFakeProvider();
  const handle: SandboxHandle = {
    id: "vm-gate-host-escape",
    name: "vm-gate-host-escape",
    labels: { tenant: "t", session: "s" },
  };
  const ops = createRemoteOperations({ provider, handle, cwd: "/work", timeout: 10 });
  return { provider, handle, ops };
}

/** Stub Pi tool factories that simply record they received the remote operations. */
function stubFactories(): RemoteToolFactories & { seen: Record<string, unknown> } {
  const seen: Record<string, unknown> = {};
  const mk = (name: string) => (_cwd: string, o: { operations: unknown }) => {
    seen[name] = o.operations;
    return { name };
  };
  return {
    seen,
    createBashTool: mk("bash"),
    createReadTool: mk("read"),
    createWriteTool: mk("write"),
    createEditTool: mk("edit"),
    createFindTool: mk("find"),
    createLsTool: mk("ls"),
  };
}

/** A unique VM path + matching host path to assert host-absence. */
function uniquePaths(suffix: string): { vm: string; host: string } {
  const id = randomUUID();
  const vm = `/tmp/pi-gate-${suffix}-${id}.txt`;
  const host = join(tmpdir(), `pi-gate-${suffix}-${id}.txt`);
  return { vm, host };
}

/** Assert the host file does not exist; clean up if a rogue run created it. */
function assertHostAbsent(host: string): void {
  expect(existsSync(host)).toBe(false);
  if (existsSync(host)) rmSync(host, { force: true });
}

function quote(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

// ---------------------------------------------------------------------------
// GATE-1 §29.2: host-escape — every side effect lands in the VM, not the host.
// ---------------------------------------------------------------------------

describe("GATE-1 §29.2: host-escape — seven tools execute in the VM (@gate)", () => {
  it("createRemoteTools wires all six Pi tools to remote operations (completeness guard)", () => {
    const { provider, handle } = setup();
    const factories = stubFactories();
    const { tools, operations, userBashDisabled } = createRemoteTools({
      provider,
      handle,
      cwd: "/work",
      timeout: 10,
      factories,
    });
    // The assembled toolset carries all seven built-ins + the web tools.
    for (const name of ["bash", "read", "write", "edit", "find", "ls", "grep"]) {
      expect(tools[name], `tool ${name} missing`).toBeDefined();
    }
    expect(userBashDisabled).toBe(true);
    // Every Pi-backed tool received a non-undefined remote operations bundle — a
    // default-ops tool would have thrown inside createRemoteTools (§10.2).
    for (const name of ["bash", "read", "write", "edit", "find", "ls"]) {
      expect(factories.seen[name], `${name} ops`).toBeDefined();
      expect(assertRemoteOperations(name, factories.seen[name])).toBeDefined();
    }
    expect(operations).toBeDefined();
  });

  it("bash writes a file in the VM (not the host)", async () => {
    const { provider, ops } = setup();
    const { vm, host } = uniquePaths("bash");
    const res = await ops.bash.exec(`echo 'bash-escaped' > ${quote(vm)}`, "/work", {
      onData: () => {},
    });
    expect(res.exitCode).toBe(0);
    expect(provider.fs.get(vm)).toBe("bash-escaped");
    assertHostAbsent(host);
    expect(provider.execCalls.length).toBeGreaterThan(0);
  });

  it("write creates a file in the VM (not the host)", async () => {
    const { provider, ops } = setup();
    const { vm, host } = uniquePaths("write");
    await ops.write.writeFile(vm, "written-by-write-tool");
    expect(provider.fs.get(vm)).toBe("written-by-write-tool");
    assertHostAbsent(host);
  });

  it("edit writes a modified file in the VM (not the host)", async () => {
    const { provider, ops } = setup();
    const { vm, host } = uniquePaths("edit");
    await ops.edit.writeFile(vm, "edited-content");
    expect(provider.fs.get(vm)).toBe("edited-content");
    const buf = await ops.edit.readFile(vm);
    expect(buf.toString("utf8")).toBe("edited-content");
    assertHostAbsent(host);
  });

  it("read reads a file that exists only in the VM", async () => {
    const { provider, ops } = setup();
    const { vm, host } = uniquePaths("read");
    provider.fs.set(vm, "vm-only-content");
    const buf = await ops.read.readFile(vm);
    expect(buf.toString("utf8")).toBe("vm-only-content");
    assertHostAbsent(host);
  });

  it("grep runs rg in the VM via the assembled toolset (no host process)", async () => {
    const { provider, handle } = setup();
    const { tools } = createRemoteTools({
      provider,
      handle,
      cwd: "/work",
      timeout: 10,
      factories: stubFactories(),
    });
    provider.fs.set("/work/a.txt", "hello world\nfindme here\n");
    const grep = tools.grep as {
      execute: (p: unknown) => Promise<{ content: { text: string }[] }>;
    };
    const result = await grep.execute({ pattern: "findme", path: "/work" });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("findme");
    expect(text).toContain("/work/a.txt");
    expect(provider.execCalls.some((c) => c.startsWith("rg "))).toBe(true);
  });

  it("find lists files in the VM (no host process)", async () => {
    const { provider, ops } = setup();
    provider.fs.set("/work/x.txt", "x");
    provider.fs.set("/work/y.txt", "y");
    const results = await ops.find.glob("*.txt", "/work", {
      ignore: [],
      limit: 100,
    });
    expect(results).toEqual(expect.arrayContaining(["/work/x.txt", "/work/y.txt"]));
    expect(provider.execCalls.some((c) => c.startsWith("fd "))).toBe(true);
  });

  it("ls lists VM directory entries (no host process)", async () => {
    const { provider, ops } = setup();
    provider.dirs.add("/work");
    provider.fs.set("/work/a.txt", "a");
    provider.fs.set("/work/b.txt", "b");
    const entries = await ops.ls.readdir("/work");
    expect(entries.sort()).toEqual(["a.txt", "b.txt"]);
    expect(provider.execCalls.some((c) => c.startsWith("ls "))).toBe(true);
  });

  it("materializeToolset filters disabled tools but keeps all remote-bound", () => {
    const { provider, handle } = setup();
    const out = materializeToolset(
      {
        provider,
        handle,
        cwd: "/work",
        timeout: 10,
        factories: stubFactories(),
      },
      undefined,
    );
    // Default config: all built-ins enabled (§11.1).
    for (const name of ["bash", "read", "write", "edit", "find", "ls", "grep"]) {
      expect(out.tools[name], `tool ${name} should be enabled by default`).toBeDefined();
    }
    expect(out.userBashDisabled).toBe(true);
    expect(out.operations).toBeDefined();
  });
});
