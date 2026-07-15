/**
 * Large-output spill policy tests (WP-1.4, spec §11.3).
 *
 * Outputs exceeding 100k tokens are written to a sandbox file and replaced in the
 * tool result with a truncated preview + the file path.
 */

import { describe, expect, it } from "vitest";
import type {
  ExecOptions,
  ExecResult,
  SandboxHandle,
  SandboxProvider,
  SandboxStatus,
} from "../../../../ports.js";
import {
  maybeSpillLargeOutput,
  SPILL_CHAR_THRESHOLD,
  SPILL_TOKEN_THRESHOLD,
} from "../large-output.js";

/** Fake provider that records exec calls and simulates the spill-file write. */
class SpillFakeProvider implements SandboxProvider {
  readonly fs = new Map<string, string>();
  readonly calls: ExecOptions[] = [];
  async provision() {
    return { id: "s", name: "s", labels: { tenant: "t", session: "s" } } as SandboxHandle;
  }
  async exec(handle: SandboxHandle, opts: ExecOptions): Promise<ExecResult> {
    this.calls.push(opts);
    const cmd = typeof opts.cmd === "string" ? opts.cmd : opts.cmd.join(" ");
    // printf %s '<b64>' | base64 -d > 'path'
    const m = cmd.match(/^printf %s '([^']*)' \| base64 -d > '([^']*)'$/);
    if (m) {
      this.fs.set(m[2], Buffer.from(m[1], "base64").toString("utf8"));
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }
  async *execStream() {}
  async stop() {}
  async start() {}
  async snapshot() {
    return "snap";
  }
  async destroy() {}
  async reattachByLabels() {
    return [];
  }
  async status(): Promise<SandboxStatus> {
    return "running";
  }
  async registerSecretBinding() {}
}

describe("large-output spill policy", () => {
  it("does not spill small outputs", async () => {
    const provider = new SpillFakeProvider();
    const handle: SandboxHandle = {
      id: "s",
      name: "s",
      labels: { tenant: "t", session: "s" },
    };
    const out = "x".repeat(1000);
    const res = await maybeSpillLargeOutput(out, { provider, handle });
    expect(res.spilled).toBe(false);
    expect(res.text).toBe(out);
    expect(provider.calls).toHaveLength(0);
  });

  it("spills outputs >100k tokens to a sandbox file", async () => {
    const provider = new SpillFakeProvider();
    const handle: SandboxHandle = {
      id: "s",
      name: "s",
      labels: { tenant: "t", session: "s" },
    };
    const big = "a".repeat(SPILL_CHAR_THRESHOLD + 50_000);
    const res = await maybeSpillLargeOutput(big, { provider, handle });
    expect(res.spilled).toBe(true);
    expect(res.path).toMatch(/^\/tmp\/tool-output-.*\.txt$/);
    expect(res.text).toContain("truncated");
    expect(res.path && res.text.includes(res.path)).toBe(true);
    expect(res.approxTokens).toBeGreaterThan(SPILL_TOKEN_THRESHOLD);
    // The full output was written to the VM (via exec), not the host.
    expect(provider.calls).toHaveLength(1);
    expect(res.path && provider.fs.has(res.path)).toBe(true);
    expect(res.path && provider.fs.get(res.path)).toBe(big);
  });
});
