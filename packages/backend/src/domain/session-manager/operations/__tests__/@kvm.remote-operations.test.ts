/**
 * `@kvm` real-VM validation for the Sandbox Operations adapter (WP-1.4, §29.2).
 *
 * Exercises {@link createRemoteOperations} + {@link createRemoteGrepTool} against the
 * real `MicrosandboxProvider` (WP-1.3) on a Linux/KVM host. Skipped unless `/dev/kvm`
 * is present and the msb runtime is installed. Mirrors the WP-1.3 `@kvm` suite's
 * availability gate and cleanup conventions.
 *
 * Cases:
 *  (a) bash writes a file in the VM; read reads it back (base64 round-trip).
 *  (b) write creates a file; read reads it back.
 *  (c) grep runs `rg` in the VM (ripgrep installed first if absent).
 */

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Sandbox } from "microsandbox";
import type { ProvisionSpec, SandboxHandle } from "../../../../ports.js";
import { MicrosandboxProvider } from "../../../../infra/sandbox/provider.js";
import { createRemoteOperations } from "../remote-operations.js";
import { createRemoteGrepTool } from "../tool-factory.js";
import { kvmRuntimeAvailable } from "../../../../infra/sandbox/__tests__/kvm-gate.js";

/**
 * KVM + msb runtime, or skip. Hard-fails instead under `PI_REQUIRE_INTEGRATION`
 * (R1.2) — see `kvm-gate.ts`.
 */
const KVM = kvmRuntimeAvailable("@kvm remote operations (sandbox tool adapter)");

const KVM_TIMEOUT = 180_000;

function sandboxName(tag: string): string {
  return `kvm-wp14-${tag}-${randomUUID().slice(0, 8)}`.toLowerCase();
}

function spec(name: string): ProvisionSpec {
  return {
    name,
    image: "ubuntu:22.04",
    cpus: 1,
    memoryMiB: 512,
    labels: {
      tenant: `kvm-${randomUUID().slice(0, 6)}`,
      session: `s-${randomUUID().slice(0, 6)}`,
    },
    networkPolicy: { mode: "unrestricted" },
    detached: true,
  };
}

describe.skipIf(!KVM)("@kvm remote operations", () => {
  const provider = new MicrosandboxProvider();
  const created = new Set<string>();

  afterAll(async () => {
    for (const name of created) {
      try {
        const h = await Sandbox.get(name);
        if (h.status === "running") await h.kill();
        await h.remove();
      } catch {
        /* already gone */
      }
    }
  });

  it(
    "(a) bash writes a file in the VM; read reads it back",
    async () => {
      const name = sandboxName("bash");
      created.add(name);
      const handle: SandboxHandle = await provider.provision(spec(name));
      try {
        const ops = createRemoteOperations({ provider, handle, cwd: "/root", timeout: 60 });
        const chunks: Buffer[] = [];
        const res = await ops.bash.exec("echo kvm-bash > /root/wp14.txt", "/root", {
          onData: (b) => chunks.push(b),
        });
        expect(res.exitCode).toBe(0);
        const buf = await ops.read.readFile("/root/wp14.txt");
        expect(buf.toString("utf8").trim()).toBe("kvm-bash");
      } finally {
        await provider.destroy(handle);
      }
    },
    KVM_TIMEOUT,
  );

  it(
    "(b) write creates a file; read reads it back",
    async () => {
      const name = sandboxName("write");
      created.add(name);
      const handle: SandboxHandle = await provider.provision(spec(name));
      try {
        const ops = createRemoteOperations({ provider, handle, cwd: "/root", timeout: 60 });
        await ops.write.writeFile("/root/wp14-write.txt", "written-content");
        const buf = await ops.read.readFile("/root/wp14-write.txt");
        expect(buf.toString("utf8")).toBe("written-content");
      } finally {
        await provider.destroy(handle);
      }
    },
    KVM_TIMEOUT,
  );

  it(
    "(c) grep runs rg in the VM",
    async () => {
      const name = sandboxName("grep");
      created.add(name);
      const handle: SandboxHandle = await provider.provision(spec(name));
      try {
        // Best-effort ripgrep install (ubuntu:22.04 ships none by default).
        await provider.exec(handle, {
          cmd: "rg --version || (apt-get update -qq && apt-get install -y -qq ripgrep)",
          timeout: 120,
        });
        await provider.exec(handle, { cmd: "mkdir -p /work && printf 'alpha\\nmatchme\\n' > /work/a.txt" });
        const grep = createRemoteGrepTool({ provider, handle, cwd: "/work", timeout: 60 });
        const result = await grep.execute({ pattern: "matchme", path: "/work" });
        const text = result.content[0]?.text ?? "";
        expect(text).toContain("matchme");
        expect(text).toContain("/work/a.txt");
      } finally {
        await provider.destroy(handle);
      }
    },
    KVM_TIMEOUT,
  );
});
