/**
 * GATE-1 / §29.2 — Load / capacity gate (WP-1.14, re-measured under R7.3, `@kvm`).
 *
 * Provisions N concurrent managed sessions (N via `GATE_LOAD_N`, default 5) using the
 * production wiring:
 *
 *   - the REAL {@link MicrosandboxProvider} (detached microVMs on /dev/kvm), and
 *   - the REAL {@link PiAgentSessionFactory} — a genuine Pi `AgentSession` per session
 *     (auth storage, model registry, resource loader, settings manager, JSONL
 *     `SessionManager`, the 9 sandbox-bound `customTools`, the managed extensions).
 *
 * **What this gate can and cannot measure (R7.3 — read before trusting a number).**
 * A model turn needs a live provider key, which this environment does not have. So the
 * gate measures the WOKEN, IDLE steady state — everything a session costs *before* its
 * first model token — and refuses to invent the rest:
 *
 *   - **measured**: per-session control-plane heap + RSS of the Node process, with the
 *     real `AgentSession` object graph in it (not a fake brain);
 *   - **measured**: per-VM host memory, from the msb runtime's OWN metrics
 *     (`allSandboxMetrics()` → `memoryHostResidentBytes`, the host-resident bytes backing
 *     the guest) AND from `/proc/<pid>/status:VmRSS` of the `msb sandbox --name <name>`
 *     supervisor process (the whole VMM process: guest pages + libkrun + msb itself);
 *   - **NOT measured**: anything token-driven (prompt cache, conversation history, tool
 *     results held in the transcript). Those need a live model key. The report says so.
 *
 * Heap numbers are only trustworthy with a forced GC; run the gate with
 * `NODE_OPTIONS=--expose-gc` and the report records that it did. Without it the report
 * says the heap figures are un-GC'd upper bounds.
 *
 * Writes the measured envelope to `docs/capacity.md`. Gates on `/dev/kvm` +
 * `isInstalled()`; skips cleanly otherwise (and then `docs/capacity.md` keeps whatever a
 * previous real run wrote — it is never populated from a non-measurement).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allSandboxMetrics, isInstalled } from "microsandbox";
import {
  FakeObjectStore,
  FakeSecretStore,
  FakeUsageRecorder,
} from "@pi-managed/testkit";
import type { AgentConfig, Environment } from "@pi-managed/contracts";
import { ManagedSessionRuntime } from "../../src/domain/session-manager/runtime.js";
import { InMemorySessionStore } from "../../src/domain/session-manager/session-store.js";
import { PiAgentSessionFactory } from "../../src/domain/session-manager/materialize.js";
import { MicrosandboxProvider } from "../../src/infra/sandbox/provider.js";
import type { SandboxHandle } from "../../src/domain/ports.js";
import type {
  ResolvedAgentMaterial,
  SessionRecord,
} from "../../src/domain/session-manager/types.js";

function kvmAvailable(): boolean {
  return existsSync("/dev/kvm") && isInstalled();
}

const KVM = kvmAvailable();
const RUN = KVM;
const N = Number(process.env.GATE_LOAD_N ?? 5);
const BOOT_TIMEOUT = 900_000;
const STEP_TIMEOUT = 900_000;

const DOCS_CAPACITY = fileURLToPath(
  new URL("../../../../docs/capacity.md", import.meta.url),
);

/** `globalThis.gc`, present only under `--expose-gc`. */
const forceGc: (() => void) | undefined = (globalThis as unknown as { gc?: () => void })
  .gc;

/**
 * Whether this run may overwrite `docs/capacity.md`.
 *
 * Heap/RSS numbers taken WITHOUT a forced GC are upper bounds polluted by uncollected
 * garbage. The gate always measures and always asserts; it only *publishes* when it can
 * publish a clean measurement — so a plain `pnpm test` (no `--expose-gc`) cannot silently
 * replace a good report with a weaker one. Force publication with `GATE_LOAD_PUBLISH=1`.
 */
const PUBLISH = forceGc !== undefined || process.env.GATE_LOAD_PUBLISH === "1";

/** A memory sample of THIS process (the control plane). */
interface HostSample {
  heapUsed: number;
  rss: number;
  external: number;
}

/** GC (when exposed), let the loop settle, then sample the control-plane process. */
async function sampleHost(): Promise<HostSample> {
  if (forceGc) {
    forceGc();
    await new Promise((r) => setTimeout(r, 250));
    forceGc();
  }
  await new Promise((r) => setTimeout(r, 250));
  const m = process.memoryUsage();
  return { heapUsed: m.heapUsed, rss: m.rss, external: m.external };
}

/** Per-VM memory, from the two independent host-side sources we have. */
interface VmSample {
  name: string;
  /** msb metric: host-resident bytes backing the guest (`memoryHostResidentBytes`). */
  hostResidentBytes: number | null;
  /** msb metric: memory used INSIDE the guest. */
  guestUsedBytes: number;
  /** msb metric: the guest's memory ceiling (the provisioned `memoryMiB`). */
  guestLimitBytes: number;
  /** `/proc/<pid>/status:VmRSS` of the `msb sandbox --name <name>` supervisor. */
  supervisorRssBytes: number | null;
}

/**
 * RSS of the msb VMM process that owns `name`, from `/proc`.
 *
 * Each detached microVM is an `msb sandbox --name <name> …` process; its `VmRSS` is the
 * TOTAL host cost of that VM (resident guest pages + libkrun + the supervisor's own
 * heap) — the number an operator must budget. Returns `null` when no such process is
 * found (non-Linux, or the runtime changed shape).
 */
function supervisorRss(name: string): number | null {
  let procs: string[];
  try {
    procs = readdirSync("/proc");
  } catch {
    return null;
  }
  for (const pid of procs) {
    if (!/^\d+$/.test(pid)) continue;
    let cmdline: string;
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      continue; // the process exited between readdir and read
    }
    const argv = cmdline.split("\0");
    if (!argv.some((a) => a === "msb" || a.endsWith("/msb"))) continue;
    const at = argv.indexOf("--name");
    if (at === -1 || argv[at + 1] !== name) continue;
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const kb = /^VmRSS:\s+(\d+) kB$/m.exec(status);
      return kb ? Number(kb[1]) * 1024 : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Sample every VM we provisioned (msb metrics + supervisor RSS). */
async function sampleVms(names: string[]): Promise<VmSample[]> {
  const all = await allSandboxMetrics();
  return names.map((name) => {
    const m = all[name];
    return {
      name,
      hostResidentBytes: m?.memoryHostResidentBytes ?? null,
      guestUsedBytes: m?.memoryBytes ?? 0,
      guestLimitBytes: m?.memoryLimitBytes ?? 0,
      supervisorRssBytes: supervisorRss(name),
    };
  });
}

function makeEnvironment(): Environment {
  return {
    id: "env_gate_load",
    name: "gate-load-env",
    type: "cloud",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    image: "ubuntu:22.04",
    resources: { cpus: 1, memoryMiB: 512 },
    networking: { mode: "unrestricted" },
  };
}

/**
 * The session material. The provider key is a placeholder: the REAL factory requires a
 * key to be present (§4.2 / R2.7 fail-closed) and to build the model client, but this
 * gate never sends a turn, so the key is never used to sign a request.
 */
function makeMaterial(): ResolvedAgentMaterial {
  return {
    agentConfig: {
      model: { provider: "anthropic", id: "claude-sonnet-4-5" },
    } as AgentConfig,
    providerKeys: { anthropic: "sk-ant-not-a-real-key-no-turn-is-run" },
    cwd: tmpdir(),
  };
}

interface LoadedSession {
  runtime: ManagedSessionRuntime;
  sessionId: string;
  handle: SandboxHandle | undefined;
}

const mib = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
const mibOrNull = (bytes: number | null): string =>
  bytes === null ? "_unavailable_" : mib(bytes);
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]): number => (xs.length > 0 ? sum(xs) / xs.length : 0);

describe.skipIf(!RUN)(
  "GATE-1 §29.2: load — N concurrent REAL sessions (@gate, @kvm)",
  () => {
    let provider: MicrosandboxProvider;
    const sessions: LoadedSession[] = [];
    let before: HostSample;
    let afterWake: HostSample;
    let afterExec: HostSample;
    let vms: VmSample[] = [];
    let wakeMsTotal = 0;

    beforeAll(() => {
      provider = new MicrosandboxProvider();
    }, BOOT_TIMEOUT);

    afterAll(async () => {
      for (const s of sessions) {
        try {
          s.runtime.dispose();
        } catch {
          /* best-effort */
        }
        if (s.handle) {
          try {
            await provider.destroy(s.handle);
          } catch {
            /* best-effort */
          }
        }
      }
    }, BOOT_TIMEOUT);

    it(
      `wakes ${N} concurrent sessions on the real factory + real microVMs`,
      async () => {
        const objects = new FakeObjectStore();
        const usage = new FakeUsageRecorder();
        const secrets = new FakeSecretStore();
        const sessionsStore = new InMemorySessionStore();
        // THE POINT OF R7.3: the real Pi agent, not a fake brain.
        const factory = new PiAgentSessionFactory();
        const env = makeEnvironment();

        before = await sampleHost();

        for (let i = 0; i < N; i++) {
          const sessionId = `sess_gate_load_${i}`;
          const dir = join(tmpdir(), `pi-gate-load-${i}`);
          mkdirSync(dir, { recursive: true });
          const jsonlPath = join(dir, "session.jsonl");
          writeFileSync(
            jsonlPath,
            `{"type":"session","version":3,"id":"${sessionId}","timestamp":"${new Date().toISOString()}","cwd":"${dir}"}\n`,
          );
          const record: SessionRecord = {
            sessionId,
            tenantId: "tnt_gate_load",
            localJsonlPath: jsonlPath,
            objectStoreKey: `sessions/${sessionId}/session.jsonl`,
            material: makeMaterial(),
            environment: env,
            vaultIds: [],
          };
          sessionsStore.seed(record);
          const runtime = new ManagedSessionRuntime({
            sandbox: provider,
            objects,
            usage,
            secrets,
            sessions: sessionsStore,
            factory,
          });
          const t0 = Date.now();
          await runtime.wake(sessionId);
          wakeMsTotal += Date.now() - t0;
          sessions.push({ runtime, sessionId, handle: runtime.sandboxHandle });
        }

        afterWake = await sampleHost();

        // All N are simultaneously awake, each holding a real AgentSession + a live VM.
        expect(sessions).toHaveLength(N);
        for (const s of sessions) {
          expect(s.runtime.status()).toBe("idle");
          expect(s.handle).toBeDefined();
        }
      },
      STEP_TIMEOUT,
    );

    it(
      "measures per-VM host memory from the msb runtime",
      async () => {
        // A real exec in each guest: the VM is doing work, not just booted-and-parked.
        await Promise.all(
          sessions.map(async (s) => {
            const out = await provider.exec(s.handle!, {
              cmd: ["/bin/sh", "-c", "echo gate-load-ok"],
            });
            expect(out.exitCode).toBe(0);
            expect(out.stdout).toContain("gate-load-ok");
          }),
        );

        afterExec = await sampleHost();
        vms = await sampleVms(sessions.map((s) => s.handle!.name));

        // Per-VM host memory IS available: msb's `SandboxMetrics.memoryHostResidentBytes`
        // plus the supervisor's /proc RSS. If a runtime bump removes either source this
        // gate must FAIL, not quietly publish a capacity doc that omits the dominant cost.
        expect(vms).toHaveLength(N);
        for (const vm of vms) {
          expect(vm.hostResidentBytes).toBeGreaterThan(0);
          expect(vm.supervisorRssBytes).toBeGreaterThan(0);
          expect(vm.guestLimitBytes).toBe(512 * 1024 * 1024);
        }
      },
      STEP_TIMEOUT,
    );

    it(
      "publishes the measured capacity envelope to docs/capacity.md",
      () => {
        const hostResident = vms.map((v) => v.hostResidentBytes ?? 0);
        const supervisorRssAll = vms.map((v) => v.supervisorRssBytes ?? 0);
        const guestUsed = vms.map((v) => v.guestUsedBytes);

        const heapPerSession = (afterWake.heapUsed - before.heapUsed) / N;
        const rssPerSession = (afterWake.rss - before.rss) / N;
        const vmPerSession = mean(supervisorRssAll);
        const totalPerSession = rssPerSession + vmPerSession;
        const ceilingPerSession = rssPerSession + 512 * 1024 * 1024;

        const gcNote = forceGc
          ? "forced GC before every sample (`--expose-gc` present)"
          : "**no forced GC** (`--expose-gc` absent) — the heap/RSS figures are upper " +
            "bounds and may include uncollected garbage";

        const report = `# Phase-1 Capacity Envelope (§29.2 load gate, re-measured under R7.3)

> **Generated by \`packages/backend/test/phase1-gate/load.gate.test.ts\` on a real run.**
> Every number below was produced by that gate on a Linux/KVM host with the msb runtime,
> against the REAL \`PiAgentSessionFactory\` and REAL detached microVMs. When the gate
> skips (no KVM) this file is NOT rewritten: it is never populated from a
> non-measurement.
>
> Measured **${new Date().toISOString()}** · host: ${cpus().length} vCPU, ${mib(
          totalmem(),
        )} RAM · Node ${process.version}
>
> Reproduce (heap figures require a forced GC, so the report is only published from a
> run that has one):
>
> \`\`\`
> NODE_OPTIONS=--expose-gc pnpm --filter @pi-managed/backend exec \\
>   vitest run test/phase1-gate/load.gate.test.ts
> \`\`\`

## What was measured — and what was not

**Measured (real).** ${N} sessions woken through the production path and held
simultaneously awake. Each session = a real \`ManagedSessionRuntime\` + a real Pi
\`AgentSession\` (built by \`PiAgentSessionFactory\`: in-memory auth storage, model
registry, per-session resource loader, settings manager, JSONL \`SessionManager\`, the 9
sandbox-bound \`customTools\`, the managed extensions) + a real detached microVM, with a
real \`exec\` executed inside every guest.

**NOT measured — needs a live provider key.** No model turn was run. Nothing token-driven
is in these numbers: no prompt cache, no conversation transcript, no tool output retained
in history, no per-turn model-client allocation. **A session under real load costs
strictly more than the figures below, by an amount this environment cannot measure.**
Treat every number here as a **floor**: the cost of a session that has not yet spoken to a
model.

## Method

- N = ${N} sessions (override with \`GATE_LOAD_N\`), woken sequentially, then all held
  awake at the same time.
- Control plane: \`process.memoryUsage()\` of the Node process, sampled before the first
  wake and after the Nth — ${gcNote}.
- Per-VM memory, from two independent host-side sources:
  1. \`allSandboxMetrics()\` (msb SDK) → \`memoryHostResidentBytes\`: the host-resident
     bytes backing the guest, as the runtime accounts them;
  2. \`/proc/<pid>/status:VmRSS\` of each \`msb sandbox --name <name>\` supervisor: the
     entire VMM process (resident guest pages + libkrun + msb's own memory). **This is the
     number to budget with** — it is what the host actually pays per VM.
- VM shape: \`ubuntu:22.04\`, 1 vCPU, 512 MiB guest ceiling.

## Measured (this run)

### Control plane (one Node process holding all ${N} sessions)

| | before wake | after ${N} wakes | Δ per session |
|---|---|---|---|
| heapUsed | ${mib(before.heapUsed)} | ${mib(afterWake.heapUsed)} | **${mib(
          heapPerSession,
        )}** |
| RSS | ${mib(before.rss)} | ${mib(afterWake.rss)} | **${mib(rssPerSession)}** |
| external | ${mib(before.external)} | ${mib(afterWake.external)} | ${mib(
          (afterWake.external - before.external) / N,
        )} |

After the in-guest execs: RSS ${mib(afterExec.rss)}, heapUsed ${mib(afterExec.heapUsed)}.
Mean wake latency (provision + boot + real agent construction): ${(
          wakeMsTotal /
          N /
          1000
        ).toFixed(1)} s/session.

### Per-VM (the dominant cost)

| session | msb \`memoryHostResidentBytes\` | supervisor \`VmRSS\` | guest \`memoryBytes\` in use |
|---|---|---|---|
${vms
  .map(
    (v, i) =>
      `| ${i} | ${mibOrNull(v.hostResidentBytes)} | ${mibOrNull(
        v.supervisorRssBytes,
      )} | ${mib(v.guestUsedBytes)} |`,
  )
  .join("\n")}
| **mean** | **${mib(mean(hostResident))}** | **${mib(
          mean(supervisorRssAll),
        )}** | ${mib(mean(guestUsed))} |

The guest ceiling is 512 MiB, but a guest only *resides* what it touches, so the measured
resident cost sits far below it. **Memory is overcommitted by design.** A capacity model
that multiplies sessions × 512 MiB is wrong by roughly an order of magnitude; a model that
assumes the idle RSS above is wrong the other way the moment an agent allocates inside the
guest (a build, a test run, a large file). 512 MiB is the worst case one session can force.

### Per-session total (idle, no model turn)

| component | per session |
|---|---|
| control-plane RSS | ${mib(rssPerSession)} |
| microVM supervisor RSS | ${mib(vmPerSession)} |
| **total (measured floor)** | **${mib(totalPerSession)}** |
| worst case, guest touching its whole ceiling | ${mib(ceilingPerSession)} |

## What this licenses — and what it does not

**Licensed by the data.** The floor per idle woken session on this host is
${mib(totalPerSession)}. The control plane is NOT the constraint: ${mib(rssPerSession)} per
session, a rounding error beside the VM. The per-session ceiling is bounded by the guest's
512 MiB limit plus the control-plane share.

**NOT licensed by the data: any per-tier concurrency number.** Two inputs are missing:
(1) the token-driven steady-state cost (no live key ⇒ not measured), and (2) a production
host memory budget — these figures are *per host*, while a tier quota is a *per-tenant*
policy over a *fleet*. What the data does bound is the arithmetic: on a host with M usable
bytes, concurrent sessions ≤ M / (per-session total), i.e. between M / ${mib(
          totalPerSession,
        )} (all guests idle) and M / ${mib(ceilingPerSession)} (every guest at its
ceiling). The per-tier defaults in \`domain/tier-config/config.ts\` and
\`domain/quota/plans.ts\` (free=2 / pro=10 / enterprise=50) were **not** derived from this
measurement and are **not** derivable from it.

## Open (what a live provider key would close)

1. **Token-driven steady state.** Re-run this gate with a real key over a real multi-turn
   workload: prompt cache + transcript + tool material per session, and how they grow with
   turns. Until then no number here describes a session that is actually working.
2. **Soak.** N sessions × hours: is per-session memory flat or creeping (JSONL sync
   buffers, the outbound event ring, the agent transcript)?
3. **Fleet arithmetic.** Per-tier quotas need a host budget and an overcommit policy on
   top of a per-session figure.
`;
        expect(report).toContain(`N = ${N} sessions`);
        if (PUBLISH) {
          writeFileSync(DOCS_CAPACITY, report, "utf8");
        } else {
          // Un-GC'd heap figures are not publishable; keep the last clean report.
          // (The measurement + its assertions above still ran and still passed.)
          expect(existsSync(DOCS_CAPACITY)).toBe(true);
        }
      },
      STEP_TIMEOUT,
    );
  },
);

// Always-on smoke: without KVM the gate can measure nothing and must not pretend to —
// `docs/capacity.md` is left exactly as the last REAL run wrote it.
describe.skipIf(RUN)("GATE-1 §29.2: load — KVM unavailable (@gate)", () => {
  it("does not write a capacity report without a real measurement", () => {
    expect(KVM).toBe(false);
  });
});
