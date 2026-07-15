/**
 * `@kvm` upgrade-gating suite (WP-1.3, §30 item 13).
 *
 * Exercises the real `MicrosandboxProvider` against live microsandbox microVMs on a
 * Linux/KVM host. The whole suite is skipped unless `/dev/kvm` is present AND the msb
 * runtime is installed (`import('microsandbox').then(m => m.install())` — one-time
 * bootstrap). This is the upstream-version gating surface: pinning msb at 0.6.6 means
 * these tests must stay green before bumping.
 *
 * Cases (per WP-1.3 brief):
 *  (a) provision a tiny `ubuntu:22.04` VM, exec `echo hello`, assert stdout.
 *  (b) stop → start: filesystem is preserved across the cold reboot (§10.3).
 *  (c) snapshot → destroy → restore-from-snapshot (SDK capability; restore is not a
 *      port method, so snapshot/restore here use the SDK directly around provider
 *      provision/stop/destroy).
 *  (d) secret binding: register a `$MSB_TEST` binding, exec `echo $MSB_TEST` — the
 *      placeholder is visible in the guest; the real value is NOT (it is substituted
 *      host-side only at egress to an allowed host, which requires TLS interception —
 *      §30 item 14, OPEN; documented, not asserted here).
 */

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Sandbox } from "microsandbox";
import type { ProvisionSpec } from "../../../domain/ports.js";
import { MicrosandboxProvider } from "../provider.js";
import { kvmRuntimeAvailable } from "./kvm-gate.js";

/**
 * KVM + msb runtime, or skip. Hard-fails instead under `PI_REQUIRE_INTEGRATION`
 * (R1.2) — see `kvm-gate.ts`.
 */
const KVM = kvmRuntimeAvailable("@kvm MicrosandboxProvider (real microVM lifecycle)");

/** One VM op can take tens of seconds (boot/snapshot); allow generous per-test time. */
const KVM_TIMEOUT = 180_000;

/** Test secret resolver — returns a fixed value + allowed host (never logged). */
const kvmResolver = {
  async resolve() {
    return { value: "kvm-secret-real-value", allowedHosts: ["example.com"] };
  },
};

function sandboxName(tag: string): string {
  return `kvm-${tag}-${randomUUID().slice(0, 8)}`.toLowerCase();
}

function spec(name: string, image = "alpine"): ProvisionSpec {
  return {
    name,
    image,
    cpus: 1,
    memoryMiB: 256,
    labels: {
      tenant: `kvm-${randomUUID().slice(0, 6)}`,
      session: `s-${randomUUID().slice(0, 6)}`,
    },
    networkPolicy: { mode: "unrestricted" },
    detached: true,
  };
}

// Skip the whole suite when KVM / the msb runtime is unavailable.
describe.skipIf(!KVM)("@kvm MicrosandboxProvider", () => {
  const provider = new MicrosandboxProvider({ secretResolver: kvmResolver });
  const created = new Set<string>();

  afterAll(async () => {
    // Best-effort cleanup of any VMs left behind by a failed test.
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
    "(a) provisions ubuntu:22.04 and execs echo hello",
    async () => {
      const name = sandboxName("ubuntu");
      created.add(name);
      const handle = await provider.provision({ ...spec(name, "ubuntu:22.04") });
      try {
        const res = await provider.exec(handle, { cmd: "echo hello" });
        expect(res.exitCode).toBe(0);
        expect(res.stdout.trim()).toBe("hello");
      } finally {
        await provider.destroy(handle);
      }
    },
    KVM_TIMEOUT,
  );

  it(
    "(b) stop → start preserves the filesystem (cold reboot; processes lost, §10.3)",
    async () => {
      const name = sandboxName("fspersist");
      created.add(name);
      const handle = await provider.provision(spec(name));
      try {
        // Write a marker file before stop (use /root, not /tmp — /tmp is tmpfs and
        // does not survive a cold reboot; the rootfs does, §10.3).
        await provider.exec(handle, {
          cmd: "echo persist-marker > /root/marker.txt",
        });
        await provider.stop(handle);
        expect(await provider.status(handle)).toBe("stopped");
        await provider.start(handle);
        expect(await provider.status(handle)).toBe("running");
        // Filesystem survives the cold reboot.
        const res = await provider.exec(handle, { cmd: "cat /root/marker.txt" });
        expect(res.stdout).toContain("persist-marker");
      } finally {
        await provider.destroy(handle);
      }
    },
    KVM_TIMEOUT,
  );

  it(
    "(c) snapshot → destroy → restore-from-snapshot (SDK capability)",
    async () => {
      const name = sandboxName("snap");
      created.add(name);
      const handle = await provider.provision(spec(name));
      // Write a marker, then stop (snapshot requires stopped/crashed).
      await provider.exec(handle, { cmd: "echo snap-marker > /root/snap.txt" });
      await provider.stop(handle);

      // Snapshot via the SDK directly (restore is not a port method).
      const h = await Sandbox.get(name);
      const snapName = `${name}-snap`;
      const snap = await h.snapshot(snapName);
      expect(snap.path.length).toBeGreaterThan(0);

      // Destroy the original, then restore a fresh VM from the snapshot.
      await provider.destroy(handle);
      created.delete(name);

      const restoredName = sandboxName("snap-restore");
      created.add(restoredName);
      const restored = await Sandbox.builder(restoredName)
        .fromSnapshot(snapName)
        .replace()
        .cpus(1)
        .memory(256)
        .detached(true)
        .create();
      try {
        const out = await restored.shell("cat /root/snap.txt");
        expect(out.stdout()).toContain("snap-marker");
      } finally {
        await restored.stop();
        await Sandbox.remove(restoredName);
        created.delete(restoredName);
      }
    },
    KVM_TIMEOUT,
  );

  it(
    "(d) secret binding: guest sees the $MSB_ placeholder, NOT the real value (§25.5)",
    async () => {
      const name = sandboxName("secret");
      created.add(name);
      const handle = await provider.provision(spec(name));
      try {
        await provider.registerSecretBinding(handle, {
          placeholderName: "$MSB_TEST",
          category: "environment_variable",
          credentialRef: {
            tenantId: handle.labels.tenant,
            vaultId: "vault_kvm",
            credentialKey: "TEST",
          },
        });
        // The guest env var holds the placeholder; the real value is substituted
        // host-side only at egress to an allowed host (not exercised here — §30 #14).
        const res = await provider.exec(handle, { cmd: "echo [$MSB_TEST]" });
        expect(res.exitCode).toBe(0);
        expect(res.stdout).toContain("$MSB_TEST");
        expect(res.stdout).not.toContain("kvm-secret-real-value");
      } finally {
        await provider.destroy(handle);
      }
    },
    KVM_TIMEOUT,
  );
});
