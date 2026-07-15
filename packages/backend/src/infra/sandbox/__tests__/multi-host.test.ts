/**
 * Multi-host sandbox scheduling tests (WP-4.3, §7.2, §4.2).
 *
 * Covers: placement (least-loaded); host unhealthy → removed from rotation; re-attach
 * across hosts (a VM on host A is found by a label scan across the pool); liveness
 * probe (failed /healthz → markUnhealthy + webhook). Uses a mock host (Node http) for
 * the provider delegation, backed by a tiny in-memory fake provider.
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  chooseHost,
  NoHostAvailableError,
} from "../../sandbox-host-pool/placement.js";
import {
  MultiHostSandboxProvider,
  HttpHostAgent,
  type HostAgentFactory,
} from "../multi-host-provider.js";
import { LivenessMonitor } from "../../sandbox-host-pool/liveness.js";
import {
  createHostAgentTokenSource,
  isValidHostAgentToken,
  HostAgentTokenMissingError,
} from "../../sandbox-host-pool/auth.js";
import { HOST_TOKEN, MockHost } from "./mock-host.js";
import type { HostRegistryPort, HostLoad } from "../../sandbox-host-pool/types.js";
import type { ProvisionSpec, SandboxHandle } from "../../../domain/ports.js";
import type { SandboxHost, UnhealthyReason } from "../../sandbox-host-pool/types.js";

// ---------------------------------------------------------------------------
// In-memory registry (satisfies HostRegistryPort without Postgres)
// ---------------------------------------------------------------------------

class InMemoryRegistry implements HostRegistryPort {
  readonly hosts = new Map<string, SandboxHost>();
  readonly owners = new Map<string, string>(); // sandboxName -> hostId
  private placements = new Map<
    string,
    { hostId: string; cpus: number; memoryMiB: number }
  >();

  add(host: SandboxHost): void {
    this.hosts.set(host.id, host);
  }
  async listHosts(healthyOnly = false): Promise<SandboxHost[]> {
    const all = [...this.hosts.values()];
    return (healthyOnly ? all.filter((h) => h.status === "healthy") : all).sort((a, b) =>
      a.id < b.id ? -1 : 1,
    );
  }
  async getHost(id: string): Promise<SandboxHost | undefined> {
    return this.hosts.get(id);
  }
  async placementUsage(): Promise<Map<string, HostLoad>> {
    const usage = new Map<string, HostLoad>();
    for (const p of this.placements.values()) {
      const cur = usage.get(p.hostId) ?? { count: 0, cpus: 0, memoryMiB: 0 };
      cur.count += 1;
      cur.cpus += p.cpus;
      cur.memoryMiB += p.memoryMiB;
      usage.set(p.hostId, cur);
    }
    return usage;
  }
  async recordPlacement(
    sandboxName: string,
    hostId: string,
    resources?: { cpus: number; memoryMiB: number },
  ): Promise<void> {
    const existing = this.placements.get(sandboxName);
    this.owners.set(sandboxName, hostId);
    this.placements.set(sandboxName, {
      hostId,
      cpus: resources?.cpus ?? existing?.cpus ?? 1,
      memoryMiB: resources?.memoryMiB ?? existing?.memoryMiB ?? 512,
    });
  }
  async getOwner(sandboxName: string): Promise<string | undefined> {
    return this.owners.get(sandboxName);
  }
  async removePlacement(sandboxName: string): Promise<void> {
    this.owners.delete(sandboxName);
    this.placements.delete(sandboxName);
  }

  // -- LivenessRegistryPort --------------------------------------------
  async markHealthy(id: string): Promise<void> {
    const h = this.hosts.get(id);
    if (h) h.status = "healthy";
  }
  async markUnhealthy(id: string, _reason: UnhealthyReason): Promise<void> {
    const h = this.hosts.get(id);
    if (h) h.status = "unhealthy";
  }
  async updateHeartbeat(id: string, at: Date = new Date()): Promise<void> {
    const h = this.hosts.get(id);
    if (h) h.lastHeartbeat = at.toISOString();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHost(id: string, cpus = 4, mem = 4096): SandboxHost {
  return {
    id,
    endpoint: "",
    cpus,
    memoryMiB: mem,
    status: "healthy",
    labels: {},
    lastHeartbeat: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function spec(name: string): ProvisionSpec {
  return {
    name,
    image: "ubuntu:22.04",
    cpus: 1,
    memoryMiB: 512,
    networkPolicy: { mode: "unrestricted" },
    labels: { tenant: "tnt_test", session: "sess_a" },
    detached: true,
  };
}

const startedMocks: MockHost[] = [];
async function mockHost(hostId: string): Promise<MockHost> {
  const m = new MockHost(hostId);
  await m.start();
  startedMocks.push(m);
  return m;
}
afterEach(async () => {
  await Promise.all(startedMocks.splice(0).map((m) => m.stop()));
});

/** Factory: HttpHostAgent clients pointing at a map of mock hosts. */
function httpFactory(mocks: Map<string, MockHost>): HostAgentFactory {
  return (host) => {
    const m = mocks.get(host.id);
    if (!m) throw new Error(`no mock for host ${host.id}`);
    // Use the mock's live endpoint (the host record endpoint may be blank).
    return new HttpHostAgent(host.id, m.endpoint, { token: HOST_TOKEN });
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("placement", () => {
  it("chooses the least-loaded healthy host", () => {
    const a = makeHost("host_a", 4, 4096);
    const b = makeHost("host_b", 4, 4096);
    const load = new Map<string, HostLoad>([
      ["host_a", { count: 3, cpus: 3, memoryMiB: 1536 }],
      ["host_b", { count: 1, cpus: 1, memoryMiB: 512 }],
    ]);
    const chosen = chooseHost(spec("vm1"), [a, b], load);
    expect(chosen.id).toBe("host_b");
  });

  it("breaks ties by most free capacity", () => {
    const small = makeHost("host_small", 2, 4096);
    const big = makeHost("host_big", 8, 4096);
    const chosen = chooseHost(spec("vm1"), [small, big], new Map()); // both 0 placements
    expect(chosen.id).toBe("host_big");
  });

  it("throws when no healthy host fits capacity", () => {
    const weak = makeHost("host_weak", 1, 256); // too small for spec (needs 1 cpu/512)
    expect(() => chooseHost(spec("vm1"), [weak])).toThrow(NoHostAvailableError);
  });

  it("subtracts live placements from capacity (admission control, ROB-17)", () => {
    // A 4-cpu host whose placements already reserve all 4 cpus has no remaining headroom,
    // so a new 1-cpu spec cannot be admitted even though TOTAL capacity looks sufficient.
    const full = makeHost("host_full", 4, 4096);
    const load = new Map<string, HostLoad>([
      ["host_full", { count: 4, cpus: 4, memoryMiB: 2048 }],
    ]);
    expect(() => chooseHost(spec("vm1"), [full], load)).toThrow(NoHostAvailableError);
  });

  it("admits onto a host with remaining capacity, not an oversubscribed peer", () => {
    const busy = makeHost("host_busy", 4, 4096);
    const free = makeHost("host_free", 4, 4096);
    const load = new Map<string, HostLoad>([
      ["host_busy", { count: 4, cpus: 4, memoryMiB: 4096 }], // no headroom
      ["host_free", { count: 0, cpus: 0, memoryMiB: 0 }],
    ]);
    expect(chooseHost(spec("vm1"), [busy, free], load).id).toBe("host_free");
  });

  it("skips unhealthy hosts", () => {
    const dead = makeHost("host_dead");
    dead.status = "unhealthy";
    const alive = makeHost("host_alive");
    const chosen = chooseHost(spec("vm1"), [dead, alive]);
    expect(chosen.id).toBe("host_alive");
  });
});

describe("MultiHostSandboxProvider", () => {
  it("provisions on the least-loaded host and records ownership", async () => {
    const registry = new InMemoryRegistry();
    registry.add(makeHost("host_a"));
    registry.add(makeHost("host_b"));
    const mocks = new Map<string, MockHost>([
      ["host_a", await mockHost("host_a")],
      ["host_b", await mockHost("host_b")],
    ]);
    const provider = new MultiHostSandboxProvider({
      registry,
      agentFactory: httpFactory(mocks),
    });

    const h1 = await provider.provision(spec("vm1"));
    expect(h1.name).toBe("vm1");
    // host_a and host_b tied (0 each) → host_big-like tiebreak by capacity (equal here)
    // so first by id order. Then a second provision should prefer the emptier host.
    const owner1 = await registry.getOwner("vm1");
    expect(owner1).toBeDefined();

    await provider.provision(spec("vm2"));
    // After vm1 on host_a (placement count 1), vm2 should go to host_b (count 0).
    expect(await registry.getOwner("vm2")).toBe(
      owner1 === "host_a" ? "host_b" : "host_a",
    );
  });

  it("routes exec/status/snapshot/stop to the owning host", async () => {
    const registry = new InMemoryRegistry();
    registry.add(makeHost("host_a"));
    const mocks = new Map([["host_a", await mockHost("host_a")]] as const);
    const provider = new MultiHostSandboxProvider({
      registry,
      agentFactory: httpFactory(mocks),
    });

    const handle = await provider.provision(spec("vm1"));
    const out = await provider.exec(handle, { cmd: "echo hi" });
    expect(out.stdout).toBe("ran:echo hi");
    expect(await provider.status(handle)).toBe("running");
    const snap = await provider.snapshot(handle);
    expect(snap).toBe("vm1-snap");
    await provider.stop(handle);
    expect(await provider.status(handle)).toBe("stopped");
  });

  it("removes an unhealthy host from rotation (provision skips it)", async () => {
    const registry = new InMemoryRegistry();
    const a = makeHost("host_a");
    const b = makeHost("host_b");
    registry.add(a);
    registry.add(b);
    const mocks = new Map<string, MockHost>([
      ["host_a", await mockHost("host_a")],
      ["host_b", await mockHost("host_b")],
    ]);
    const provider = new MultiHostSandboxProvider({
      registry,
      agentFactory: httpFactory(mocks),
    });

    // Mark host_a unhealthy; both have 0 placements so without rotation removal it
    // might pick host_a by id. With removal, it must pick host_b.
    a.status = "unhealthy";
    const handle = await provider.provision(spec("vm1"));
    expect(await registry.getOwner(handle.name)).toBe("host_b");
    expect(mocks.get("host_a")!.provider["vms"].has("vm1")).toBe(false);
    expect(mocks.get("host_b")!.provider["vms"].has("vm1")).toBe(true);
  });

  it("re-attaches a VM across the pool by label scan (VM on host A is found)", async () => {
    const registry = new InMemoryRegistry();
    registry.add(makeHost("host_a"));
    registry.add(makeHost("host_b"));
    const mocks = new Map<string, MockHost>([
      ["host_a", await mockHost("host_a")],
      ["host_b", await mockHost("host_b")],
    ]);
    const provider = new MultiHostSandboxProvider({
      registry,
      agentFactory: httpFactory(mocks),
    });

    // Provision a VM; it lands on some host. Then simulate a backend restart by
    // dropping the in-memory placement row (the VM still lives on its host).
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const handle = await provider.provision(spec("vm1"));
    const originalOwner = (await registry.getOwner("vm1"))!;
    registry.owners.delete("vm1"); // forget placement — like a fresh boot.

    // reattachByLabels scans all healthy hosts and rediscovers the VM.
    const found = await provider.reattachByLabels({
      tenant: "tnt_test",
      session: "sess_a",
    });
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe("vm1");
    // Placement is reconciled back to the original owner.
    expect(await registry.getOwner("vm1")).toBe(originalOwner);
  });

  it("throws when no healthy host can fit the spec", async () => {
    const registry = new InMemoryRegistry();
    const weak = makeHost("host_weak", 1, 256);
    registry.add(weak);
    const provider = new MultiHostSandboxProvider({
      registry,
      agentFactory: httpFactory(new Map()),
    });
    await expect(provider.provision(spec("vm1"))).rejects.toThrow(NoHostAvailableError);
  });
});

describe("host-agent authentication (§6.1 trust model)", () => {
  it("rejects an unauthenticated /exec with 401 and does not run the command", async () => {
    const m = await mockHost("host_a");
    const handle: SandboxHandle = m.provider.provision(spec("vm1"));

    const res = await fetch(`${m.endpoint}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle, opts: { cmd: "cat /etc/shadow" } }),
    });

    expect(res.status).toBe(401);
    await expect(res.text()).resolves.not.toContain("ran:");
  });

  it("rejects a wrong bearer token with 401", async () => {
    const m = await mockHost("host_a");
    const handle: SandboxHandle = m.provider.provision(spec("vm1"));

    const res = await fetch(`${m.endpoint}/exec`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${"x".repeat(HOST_TOKEN.length)}`,
      },
      body: JSON.stringify({ handle, opts: { cmd: "cat /etc/shadow" } }),
    });

    expect(res.status).toBe(401);
  });

  it("rejects unauthenticated /list-by-labels (no cross-tenant VM enumeration)", async () => {
    const m = await mockHost("host_a");
    m.provider.provision(spec("vm1"));

    const res = await fetch(`${m.endpoint}/list-by-labels`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant: "tnt_test" }),
    });

    expect(res.status).toBe(401);
  });

  it("accepts a request bearing the host's shared secret", async () => {
    const m = await mockHost("host_a");
    const agent = new HttpHostAgent("host_a", m.endpoint, { token: HOST_TOKEN });

    const handle = await agent.provision(spec("vm1"));
    const out = await agent.exec(handle, { cmd: "echo hi" });
    expect(out.stdout).toBe("ran:echo hi");
    expect(await agent.healthz()).toBe(true);
  });

  it("healthz requires the shared secret too", async () => {
    const m = await mockHost("host_a");
    const res = await fetch(`${m.endpoint}/healthz`);
    expect(res.status).toBe(401);
  });

  it("isValidHostAgentToken compares constant-time and rejects mismatches", () => {
    expect(isValidHostAgentToken(`Bearer ${HOST_TOKEN}`, HOST_TOKEN)).toBe(true);
    expect(isValidHostAgentToken(`bearer ${HOST_TOKEN}`, HOST_TOKEN)).toBe(true);
    expect(isValidHostAgentToken(`Bearer ${HOST_TOKEN}x`, HOST_TOKEN)).toBe(false);
    expect(isValidHostAgentToken(HOST_TOKEN, HOST_TOKEN)).toBe(false); // scheme required
    expect(isValidHostAgentToken(undefined, HOST_TOKEN)).toBe(false);
    expect(isValidHostAgentToken("Bearer ", HOST_TOKEN)).toBe(false);
  });

  it("token source reads a per-host secret from config, else the pool-wide one", () => {
    const tokens = createHostAgentTokenSource({
      SANDBOX_HOST_AGENT_TOKEN: "pool-wide",
      SANDBOX_HOST_AGENT_TOKEN_HOST_A: "host-a-only",
    });
    expect(tokens(makeHost("host_a"))).toBe("host-a-only");
    expect(tokens(makeHost("host_b"))).toBe("pool-wide");
  });

  it("fails closed when no secret is configured for a host", () => {
    const tokens = createHostAgentTokenSource({});
    expect(() => tokens(makeHost("host_a"))).toThrow(HostAgentTokenMissingError);
  });
});

describe("LivenessMonitor", () => {
  it("marks a host unhealthy after threshold failures and alerts via webhook", async () => {
    const registry = new InMemoryRegistry();
    const host = makeHost("host_a");
    registry.add(host);
    const dispatched: string[] = [];
    const monitor = new LivenessMonitor(registry, {
      failureThreshold: 2,
      probe: async () => false, // always fails
      webhookSink: { dispatch: async (e) => void dispatched.push(e.type) },
    });

    await monitor.probeOnce(); // 1 failure
    expect(host.status).toBe("healthy");
    await monitor.probeOnce(); // 2 failures → threshold
    expect(host.status).toBe("unhealthy");
    expect(dispatched).toContain("sandbox.host_unhealthy");
  });

  it("recovers a host and clears failures on a successful probe", async () => {
    const registry = new InMemoryRegistry();
    const host = makeHost("host_a");
    registry.add(host);
    let healthy = false;
    const monitor = new LivenessMonitor(registry, {
      failureThreshold: 1,
      probe: async () => healthy,
    });
    await monitor.probeOnce();
    expect(host.status).toBe("unhealthy");

    healthy = true;
    await monitor.probeOnce();
    expect(host.status).toBe("healthy");
    expect(host.lastHeartbeat).not.toBeNull();
  });

  it("default probe hits /healthz over HTTP (mock host)", async () => {
    const registry = new InMemoryRegistry();
    const m = await mockHost("host_a");
    const host = makeHost("host_a");
    host.endpoint = m.endpoint;
    registry.add(host);
    const monitor = new LivenessMonitor(registry, {
      failureThreshold: 1,
      tokenSource: () => HOST_TOKEN,
    });
    await monitor.probeOnce();
    expect(host.status).toBe("healthy");
    expect(host.lastHeartbeat).not.toBeNull();

    m.setHealthy(false);
    await monitor.probeOnce();
    expect(host.status).toBe("unhealthy");
  });
});
