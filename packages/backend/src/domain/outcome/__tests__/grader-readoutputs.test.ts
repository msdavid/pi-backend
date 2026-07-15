/**
 * Regression test for the shell-injection class in `SubagentGrader.readOutputs`
 * (R0.9 addendum — second instance of the `domain/file/outputs.ts` finding).
 *
 * A malicious agent can write an output file whose NAME contains shell
 * metacharacters (e.g. `x;touch /tmp/pwned`). `readOutputs` lists the outputs
 * dir and then `cat`s each name. If the name is interpolated into a shell string
 * run via `provider.exec` (`sh -c`), the injected command executes on the next
 * grader pass. Impact is bounded to the session's own same-tenant sandbox, but it
 * is a real injection and must not build shell strings from agent-controlled input.
 *
 * The fix: pass argv ARRAYS (`["cat","--",path]`, `["ls","-1",dir]`) so no shell
 * is involved. This test asserts the provider receives argv arrays and that the
 * malicious filename lands as a single, un-split argv element.
 */

import { describe, expect, it } from "vitest";
import type {
  ExecOptions,
  ExecResult,
  ExecChunk,
  ProvisionSpec,
  SandboxHandle,
  SandboxProvider,
  SandboxStatus,
  SnapshotId,
} from "../../ports.js";
import type { TenantCtx } from "../../../infra/db/index.js";
import { OUTPUTS_DIR, type SessionSandboxResolver } from "../../file/outputs.js";
import { SandboxOutputsResolver } from "../grader.js";

/** Records every exec command; simulates a compromised outputs dir. */
class RecordingProvider implements SandboxProvider {
  readonly execCalls: (string | string[])[] = [];
  /** The (attacker-controlled) filenames present in /mnt/session/outputs/. */
  constructor(private readonly names: string[]) {}

  async exec(_handle: SandboxHandle, opts: ExecOptions): Promise<ExecResult> {
    this.execCalls.push(opts.cmd);
    const cmd = Array.isArray(opts.cmd) ? opts.cmd.join(" ") : opts.cmd;
    // Emulate `ls -1 <dir>` -> the attacker's filenames.
    if (cmd.includes("ls")) {
      return { stdout: this.names.join("\n"), stderr: "", exitCode: 0 };
    }
    return { stdout: "file-body", stderr: "", exitCode: 0 };
  }
  // --- unused SandboxProvider surface -------------------------------------
  async provision(spec: ProvisionSpec): Promise<SandboxHandle> {
    return { id: spec.name, name: spec.name, labels: spec.labels };
  }
  async *execStream(): AsyncIterable<ExecChunk> {}
  async stop(): Promise<void> {}
  async start(): Promise<void> {}
  async destroy(): Promise<void> {}
  async snapshot(): Promise<SnapshotId> {
    return "snap_x" as SnapshotId;
  }
  async status(): Promise<SandboxStatus> {
    return "running";
  }
  async reattachByLabels(): Promise<SandboxHandle[]> {
    return [];
  }
  async registerSecretBinding(): Promise<void> {}
}

const CTX: TenantCtx = { tenantId: "t_test" };
const HANDLE: SandboxHandle = {
  id: "sb_1",
  name: "sb_1",
  labels: { tenant: "t_test", session: "sess_1" },
};

function makeResolver(): SessionSandboxResolver {
  return { resolve: async () => HANDLE };
}

describe("SubagentGrader.readOutputs — shell-injection hardening (R0.9)", () => {
  it("passes a malicious filename as a single argv element, never a shell string", async () => {
    // A real filename cannot contain `/` (the grader already filters those), so the
    // injection payload uses other shell metacharacters: `;` command separator +
    // `$(...)` substitution. These survive the existing filter and, under `sh -c`,
    // would execute. Under argv they are inert.
    const evil = "x;touch_pwned_$(id)";
    const provider = new RecordingProvider([evil, "normal.txt"]);
    const outputs = new SandboxOutputsResolver(provider, makeResolver());

    await outputs.readOutputs(CTX, "sess_1");

    // Every exec must be an argv array (no `sh -c "<interpolated>"`).
    for (const cmd of provider.execCalls) {
      expect(Array.isArray(cmd)).toBe(true);
    }

    // The malicious name must appear as ONE element, not split by the shell,
    // and no exec command string may contain the injected `;touch` as separate
    // shell syntax (i.e. the metacharacters are inert data).
    const catCall = provider.execCalls.find(
      (c) => Array.isArray(c) && c[0] === "cat",
    ) as string[] | undefined;
    expect(catCall).toBeDefined();
    expect(catCall).toContain(`${OUTPUTS_DIR}${evil}`);
    // The `;` lives inside a single argv element — it was never a command separator.
    expect(catCall!.filter((a) => a.includes(";"))).toHaveLength(1);
  });
});
