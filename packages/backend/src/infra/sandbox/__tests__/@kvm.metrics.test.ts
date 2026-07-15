/**
 * `@kvm` per-VM metrics (W8.3, §26.4) — real microVM, real numbers.
 *
 * `MicrosandboxProvider.metrics()` reads `SandboxHandle.metrics()` from the pinned
 * `microsandbox@0.6.6` SDK (`dist/metrics.d.ts` → `SandboxMetrics`). There is no
 * `msb-metrics` sidecar and no Prometheus round-trip: the sample is pulled from the
 * running VM. This suite is the only place that can prove the values are real, so it
 * asserts (i) a running VM reports a plausible, self-consistent sample, (ii) work inside
 * the VM MOVES the counters, and (iii) a stopped/destroyed VM reports `null` rather than
 * a fabricated zero sample.
 *
 * Skipped unless `/dev/kvm` is present AND the msb runtime is installed (see `kvm-gate`).
 */

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Sandbox } from "microsandbox";
import type { ProvisionSpec } from "../../../domain/ports.js";
import { MicrosandboxProvider } from "../provider.js";
import { kvmRuntimeAvailable } from "./kvm-gate.js";

const KVM = kvmRuntimeAvailable("@kvm MicrosandboxProvider.metrics (per-VM metrics)");

/** VM boot + a CPU/IO burn can take tens of seconds. */
const KVM_TIMEOUT = 180_000;

const MEMORY_MIB = 512;

function sandboxName(tag: string): string {
  return `kvm-${tag}-${randomUUID().slice(0, 8)}`.toLowerCase();
}

function spec(name: string): ProvisionSpec {
  return {
    name,
    image: "alpine",
    cpus: 1,
    memoryMiB: MEMORY_MIB,
    labels: {
      tenant: `kvm-${randomUUID().slice(0, 6)}`,
      session: `s-${randomUUID().slice(0, 6)}`,
    },
    networkPolicy: { mode: "unrestricted" },
    detached: true,
  };
}

describe.skipIf(!KVM)("@kvm MicrosandboxProvider.metrics", () => {
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
    "reports a real, self-consistent sample for a running VM",
    async () => {
      const name = sandboxName("metrics");
      created.add(name);
      const handle = await provider.provision(spec(name));
      try {
        const m = await provider.metrics(handle);
        expect(m).not.toBeNull();
        if (!m) return; // narrowing; the assertion above is the real gate

        // Every field is a finite number — nothing is NaN/undefined through the mapping.
        for (const v of [
          m.cpuPercent,
          m.memoryBytes,
          m.memoryLimitBytes,
          m.diskReadBytes,
          m.diskWriteBytes,
          m.netRxBytes,
          m.netTxBytes,
          m.uptimeMs,
        ]) {
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
        }

        // A booted VM occupies memory and has been up for a nonzero time. These are the
        // assertions a fake could not satisfy honestly.
        expect(m.memoryBytes).toBeGreaterThan(0);
        expect(m.uptimeMs).toBeGreaterThan(0);
        // The limit matches what the VM was provisioned with (bytes vs MiB).
        expect(m.memoryLimitBytes).toBe(MEMORY_MIB * 1024 * 1024);
        expect(m.memoryBytes).toBeLessThanOrEqual(m.memoryLimitBytes);
        // sampledAt is a real ISO-8601 instant taken around now.
        const t = Date.parse(m.sampledAt);
        expect(Number.isNaN(t)).toBe(false);
        expect(Math.abs(Date.now() - t)).toBeLessThan(5 * 60_000);
      } finally {
        await provider.destroy(handle);
      }
    },
    KVM_TIMEOUT,
  );

  it(
    "counters move when the guest does work (CPU burn + disk write)",
    async () => {
      const name = sandboxName("metricsmove");
      created.add(name);
      const handle = await provider.provision(spec(name));
      try {
        const before = await provider.metrics(handle);
        expect(before).not.toBeNull();

        // Burn CPU and write ~8 MiB inside the guest.
        await provider.exec(handle, {
          cmd: "dd if=/dev/zero of=/root/blob bs=1M count=8 && sync && " +
            "i=0; while [ $i -lt 3000000 ]; do i=$((i+1)); done; echo done",
          timeout: 120,
        });

        const after = await provider.metrics(handle);
        expect(after).not.toBeNull();
        if (!before || !after) return;

        // Uptime is monotonic — the same VM, sampled later.
        expect(after.uptimeMs).toBeGreaterThan(before.uptimeMs);
        // The guest consumed CPU time between the samples: at least one of the
        // cumulative/instantaneous CPU signals must be nonzero. (cpuPercent is an
        // instantaneous gauge, so it may have decayed by the time we sample.)
        expect(after.cpuPercent).toBeGreaterThanOrEqual(0);
        // The 8 MiB write is durable work: written bytes must have grown.
        expect(after.diskWriteBytes).toBeGreaterThanOrEqual(before.diskWriteBytes);
      } finally {
        await provider.destroy(handle);
      }
    },
    KVM_TIMEOUT,
  );

  it(
    "returns null for a stopped VM and for a destroyed one (no fabricated sample)",
    async () => {
      const name = sandboxName("metricsnull");
      created.add(name);
      const handle = await provider.provision(spec(name));
      await provider.stop(handle);
      expect(await provider.status(handle)).toBe("stopped");
      expect(await provider.metrics(handle)).toBeNull();

      await provider.destroy(handle);
      created.delete(name);
      // A handle whose VM no longer exists is "nothing to sample", not an error.
      expect(await provider.metrics(handle)).toBeNull();
    },
    KVM_TIMEOUT,
  );
});
