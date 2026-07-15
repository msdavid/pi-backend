/**
 * Session-outputs shell-injection regression (§25.1, WP-R0.9).
 *
 * `downloadSessionOutput` used to interpolate the caller-supplied filename into a
 * shell string (`cat /mnt/session/outputs/<filename>`) which the microsandbox
 * provider runs via `sh -c` (infra/sandbox/provider.ts `prepareExec`). A filename
 * carrying a shell metacharacter (`x;touch pwned`) therefore ran an attacker-chosen
 * command inside the sandbox. `assertSafeBasename` rejects `/`, `\` and `..` but not
 * `;`, `|`, `&`, `$`, backticks or newlines, so a slash-free payload sailed through.
 *
 * The provider fake below reproduces `prepareExec` faithfully: a string `cmd` is run
 * through `sh -c`, an array `cmd` is exec'd directly with no shell. That makes the
 * injection *observable* (the injected `touch` really creates a file) rather than
 * merely asserted against a command string.
 */

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { downloadSessionOutput, type SessionSandboxResolver } from "../outputs.js";
import type { Pool, TenantCtx } from "../../../infra/db/index.js";
import type {
  ExecOptions,
  ExecResult,
  SandboxHandle,
  SandboxProvider,
} from "../../ports.js";

const execFileAsync = promisify(execFile);

const HANDLE: SandboxHandle = {
  id: "sb_t1-s1",
  name: "t1-s1",
  labels: { tenant: "t1", session: "s1" },
};

/**
 * Sandbox provider whose `exec` dispatches exactly like the real microsandbox
 * provider: string → `sh -c <cmd>`, array → argv exec'd directly. Records the `cmd`
 * it was handed so its shape (shell string vs argv) can be asserted. Commands run in
 * `cwd` so an injected side effect lands in a scratch directory the test owns.
 */
class ShellSemanticsProvider {
  readonly execCalls: (string | string[])[] = [];

  constructor(private readonly cwd: string) {}

  async exec(_handle: SandboxHandle, opts: ExecOptions): Promise<ExecResult> {
    this.execCalls.push(opts.cmd);
    const [cmd, ...args] = Array.isArray(opts.cmd)
      ? opts.cmd
      : ["sh", "-c", opts.cmd];
    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, { cwd: this.cwd });
      return { stdout, stderr, exitCode: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.code ?? 1 };
    }
  }
}

/** Minimal `Pool` stub: every query returns one idle session row. Supports the
 * transaction path (`connect`) that `tenantScopedQuery` uses for the RLS `SET LOCAL`. */
function idleSessionPool(): Pool {
  const query = async () => ({ rows: [{ id: "s1", status: "idle" }], rowCount: 1 });
  return {
    query,
    connect: async () => ({ query, release: () => {} }),
  } as unknown as Pool;
}

const CTX: TenantCtx = { tenantId: "t1" };
const RESOLVER: SessionSandboxResolver = {
  async resolve() {
    return HANDLE;
  },
};

describe("downloadSessionOutput — shell injection (§25.1)", () => {
  let scratch: string;
  let provider: ShellSemanticsProvider;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "pi-outputs-"));
    provider = new ShellSemanticsProvider(scratch);
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("does not execute shell metacharacters in the output filename", async () => {
    const marker = `pwned_${randomUUID()}`;
    // Slash-free payload: passes `assertSafeBasename`, but `;` ends the `cat`.
    const filename = `x;touch ${marker}`;

    await expect(
      downloadSessionOutput(
        idleSessionPool(),
        CTX,
        provider as unknown as SandboxProvider,
        RESOLVER,
        "s1",
        filename,
      ),
    ).rejects.toMatchObject({ statusCode: 404, code: "not_found" });

    // The injected command must never have run.
    expect(existsSync(join(scratch, marker))).toBe(false);
    // The filename must reach the sandbox as a single argv element — no shell.
    expect(provider.execCalls).toHaveLength(1);
    expect(provider.execCalls[0]).toEqual([
      "cat",
      "--",
      `/mnt/session/outputs/${filename}`,
    ]);
  });

  it("does not execute command substitution in the output filename", async () => {
    const marker = `subst_${randomUUID()}`;
    const filename = `x\`touch ${marker}\``;

    await expect(
      downloadSessionOutput(
        idleSessionPool(),
        CTX,
        provider as unknown as SandboxProvider,
        RESOLVER,
        "s1",
        filename,
      ),
    ).rejects.toMatchObject({ statusCode: 404, code: "not_found" });

    expect(existsSync(join(scratch, marker))).toBe(false);
    expect(provider.execCalls[0]).toEqual([
      "cat",
      "--",
      `/mnt/session/outputs/${filename}`,
    ]);
  });

  it("passes a well-formed filename as a single argv element", async () => {
    await expect(
      downloadSessionOutput(
        idleSessionPool(),
        CTX,
        provider as unknown as SandboxProvider,
        RESOLVER,
        "s1",
        "report.md",
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(provider.execCalls[0]).toEqual([
      "cat",
      "--",
      "/mnt/session/outputs/report.md",
    ]);
  });
});
