/**
 * R6.5a — memory stores mounted at session start (§13.1–13.3).
 *
 * Proves the wiring the audit found missing: `memory/mount.ts` existed but nothing called
 * it, so a session's memory stores were never mounted, never staged, and never written
 * back. The subject here is the REAL `ManagedSessionRuntime` wake/settle path — only the
 * memory service's storage backend is a fake (an in-memory volume + store list), because
 * the DB-backed one is exercised by `memory.test.ts`.
 *
 * Asserted:
 *  - a `memory_store` environment mount is resolved BEFORE provision and lands in the
 *    `ProvisionSpec`'s volumes — a `read_only` store as a **read-only** mount, so the
 *    agent cannot write to it regardless of its tools (§13.2);
 *  - each mounted store is staged into its volume after provision (the agent sees the
 *    store's current contents at `/mnt/memory/<slug>/`);
 *  - on the idle transition, a read-write volume is written back and a read-only volume
 *    is NOT (§13.1);
 *  - the mounted stores are announced in the session's system prompt (§13.1) — through
 *    the REAL Pi resource loader, not a stub.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import type { AgentConfig, Environment, MemoryStore } from "@pi-managed/contracts";
import {
  FakeObjectStore,
  FakeSandboxProvider,
  FakeSecretStore,
  FakeUsageRecorder,
} from "@pi-managed/testkit";
import { ManagedSessionRuntime } from "../runtime.js";
import { InMemorySessionStore } from "../session-store.js";
import { buildResourceLoader } from "../materialize.js";
import { InMemoryVolumeStore } from "../../memory/mount.js";
import type {
  AgentSessionEventLike,
  AgentSessionFactory,
  AgentSessionLike,
  CreateAgentSessionOptions,
  MemoryMountService,
  SessionEntryLike,
  SessionRecord,
  SessionVolumeStore,
} from "../types.js";
import type { InboundEvent } from "../../ports.js";

// -- fakes -------------------------------------------------------------------

class NoopSession implements AgentSessionLike {
  readonly sessionId = "fake-session";
  readonly sessionFile: string | undefined = undefined;
  isStreaming = false;
  async prompt(): Promise<void> {
    /* the model is not the subject here */
  }
  async steer(): Promise<void> {}
  async followUp(): Promise<void> {}
  subscribe(_l: (e: AgentSessionEventLike) => void): () => void {
    return () => {};
  }
  async abort(): Promise<void> {}
  dispose(): void {}
  getEntries(): SessionEntryLike[] {
    return [];
  }
}

class RecordingFactory implements AgentSessionFactory {
  last?: CreateAgentSessionOptions;
  create(options: CreateAgentSessionOptions): Promise<AgentSessionLike> {
    this.last = options;
    return Promise.resolve(new NoopSession());
  }
}

/**
 * The memory service with an in-memory volume per store. `stage` seeds the volume from
 * the store's "live memories"; `syncBack` records the drained files — exactly the two
 * calls the runtime must make (and must NOT make for a read-only store).
 */
class FakeMemoryService implements MemoryMountService {
  readonly volumes = new Map<string, InMemoryVolumeStore>();
  readonly staged: string[] = [];
  readonly syncedBack: Array<{ storeId: string; files: string[] }> = [];
  readonly guestPaths = new Map<string, string>();

  constructor(private readonly stores: MemoryStore[]) {}

  async resolveStores(_tenantId: string, storeIds: string[]): Promise<MemoryStore[]> {
    return this.stores.filter((s) => storeIds.includes(s.id));
  }

  volumeFor(
    store: MemoryStore,
    sandbox: { guestPath: string },
  ): SessionVolumeStore {
    this.guestPaths.set(store.id, sandbox.guestPath);
    let v = this.volumes.get(store.id);
    if (!v) {
      v = new InMemoryVolumeStore();
      this.volumes.set(store.id, v);
    }
    return v;
  }

  async stage(
    _tenantId: string,
    store: MemoryStore,
    volume: SessionVolumeStore,
  ): Promise<void> {
    this.staged.push(store.id);
    await volume.writeFile("notes.md", Buffer.from(`seed:${store.id}`, "utf8"));
  }

  async syncBack(
    _tenantId: string,
    store: MemoryStore,
    volume: SessionVolumeStore,
  ): Promise<void> {
    this.syncedBack.push({ storeId: store.id, files: await volume.listFiles() });
  }
}

// -- helpers -----------------------------------------------------------------

function memoryStore(over: Partial<MemoryStore> & { id: string }): MemoryStore {
  return {
    displayTitle: "Team Notes",
    access: "read_write",
    status: "active",
    mountPath: null,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    ...over,
  } as MemoryStore;
}

function environmentWithMounts(ids: string[]): Environment {
  return {
    id: "env_mem",
    name: "mem-env",
    type: "cloud",
    status: "active",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    image: "ubuntu:22.04",
    resources: { cpus: 1, memoryMiB: 512 },
    networking: { mode: "unrestricted" },
    mounts: ids.map((id) => ({ type: "memory_store" as const, id })),
  };
}

function seededRecord(env: Environment): SessionRecord {
  return {
    sessionId: "sess_mem",
    tenantId: "tnt_mem",
    localJsonlPath: join(mkdtempSync(join(tmpdir(), "pi-mem-")), "log.jsonl"),
    objectStoreKey: "sessions/sess_mem/log.jsonl",
    material: {
      agentConfig: {
        model: { provider: "anthropic", id: "claude-sonnet-4-5" },
        systemPrompt: "BASE PROMPT",
      } as AgentConfig,
      providerKeys: { anthropic: "sk-test" },
      cwd: "/placeholder",
      systemPromptOverride: "BASE PROMPT",
    },
    environment: env,
    vaultIds: [],
  };
}

function userMessage(content: string): InboundEvent {
  return {
    type: "user.message",
    id: `evt_${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
    payload: { content },
  };
}

async function wakeWith(stores: MemoryStore[]): Promise<{
  runtime: ManagedSessionRuntime;
  memory: FakeMemoryService;
  factory: RecordingFactory;
  sandbox: FakeSandboxProvider;
}> {
  const env = environmentWithMounts(stores.map((s) => s.id));
  const sessions = new InMemorySessionStore();
  sessions.seed(seededRecord(env));
  const memory = new FakeMemoryService(stores);
  const factory = new RecordingFactory();
  const sandbox = new FakeSandboxProvider();
  const runtime = new ManagedSessionRuntime({
    sandbox,
    objects: new FakeObjectStore(),
    usage: new FakeUsageRecorder(),
    secrets: new FakeSecretStore(),
    sessions,
    factory,
    memory,
  });
  await runtime.wake("sess_mem");
  return { runtime, memory, factory, sandbox };
}

// -- tests -------------------------------------------------------------------

describe("ManagedSessionRuntime — memory mounts (R6.5a)", () => {
  it("compiles a read_only store to a READ-ONLY volume in the ProvisionSpec", async () => {
    const ro = memoryStore({
      id: "mem_ro",
      displayTitle: "Handbook",
      access: "read_only",
    });
    const rw = memoryStore({ id: "mem_rw", displayTitle: "Scratch" });
    const { runtime } = await wakeWith([ro, rw]);

    const volumes = runtime.currentProvisionSpec?.volumes ?? [];
    const roMount = volumes.find((v) => v.guestPath === "/mnt/memory/handbook/");
    const rwMount = volumes.find((v) => v.guestPath === "/mnt/memory/scratch/");

    // The read-only store is mounted read-only: the agent cannot write to it at the
    // mount level, whatever its toolset says (§13.2).
    expect(roMount).toBeDefined();
    expect(roMount!.readOnly).toBe(true);
    expect(roMount!.source).toBe("tenants/tnt_mem/memory/mem_ro");
    // The read-write store is writable.
    expect(rwMount).toBeDefined();
    expect(rwMount!.readOnly).toBe(false);

    runtime.dispose();
  });

  it("stages each mounted store's contents after provision", async () => {
    const rw = memoryStore({ id: "mem_rw", displayTitle: "Scratch" });
    const { runtime, memory } = await wakeWith([rw]);

    expect(memory.staged).toEqual(["mem_rw"]);
    expect(memory.guestPaths.get("mem_rw")).toBe("/mnt/memory/scratch/");
    const volume = memory.volumes.get("mem_rw")!;
    expect((await volume.readFile("notes.md")).toString("utf8")).toBe("seed:mem_rw");

    runtime.dispose();
  });

  it("writes a read-write volume back on idle, and never a read-only one", async () => {
    const ro = memoryStore({
      id: "mem_ro",
      displayTitle: "Handbook",
      access: "read_only",
    });
    const rw = memoryStore({ id: "mem_rw", displayTitle: "Scratch" });
    const { runtime, memory } = await wakeWith([ro, rw]);

    // The agent edits a file in the mounted read-write volume during the turn.
    memory.volumes.get("mem_rw")!.write("notes.md", "edited by the agent");

    await runtime.sendEvent(userMessage("do work"));
    expect(runtime.status()).toBe("idle");

    // Write-back ran for the read-write store only.
    expect(memory.syncedBack.map((s) => s.storeId)).toEqual(["mem_rw"]);
    expect(memory.syncedBack[0].files).toEqual(["notes.md"]);
    const drained = await memory.volumes.get("mem_rw")!.readFile("notes.md");
    expect(drained.toString("utf8")).toBe("edited by the agent");

    runtime.dispose();
  });

  it("announces the mounted stores in the session's system prompt (real Pi loader)", async () => {
    const ro = memoryStore({
      id: "mem_ro",
      displayTitle: "Handbook",
      access: "read_only",
      instructions: "Cite the handbook section.",
    });
    const { runtime, factory } = await wakeWith([ro]);

    const material = factory.last!.material;
    expect(material.appendSystemPrompt).toEqual([
      'Memory store "Handbook" is mounted read-only at /mnt/memory/handbook/. ' +
        "Instructions: Cite the handbook section. " +
        "This store is read-only; writes will fail at the mount level.",
    ]);

    // The REAL Pi resource loader the session is built with carries both the system-prompt
    // override AND the memory notes (the flagged `systemPromptOverride` bug would show up
    // here as an empty prompt).
    const agentDir = mkdtempSync(join(tmpdir(), "pi-agentdir-"));
    const loader = buildResourceLoader(material, agentDir);
    await loader.reload();
    expect(loader.getSystemPrompt()).toBe("BASE PROMPT");
    expect(loader.getAppendSystemPrompt()).toEqual(material.appendSystemPrompt);

    runtime.dispose();
  });
});
