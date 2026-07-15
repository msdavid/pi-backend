/**
 * WP-2.6 tests — `/remote:memory` command round-trips.
 */
import { describe, it, expect, vi } from "vitest";
import type { ManagedApiClient } from "../api-client.js";
import type { Cursor, Memory, MemoryStore, MemorySummary } from "@pi-managed/contracts";
import { runMemoryList, runMemoryShow, runMemoryEdit, runMemoryMount } from "./memory.js";

function makeStore(over: Partial<MemoryStore> = {}): MemoryStore {
  return {
    id: "mem_1",
    displayTitle: "Conventions",
    instructions: "Follow patterns",
    access: "read_write",
    status: "active",
    mountPath: null,
    createdAt: "2026-07-13T12:00:00Z",
    updatedAt: "2026-07-13T12:00:00Z",
    ...over,
  };
}

function makeMemory(over: Partial<Memory> = {}): Memory {
  return {
    path: "notes.md",
    contentSha256: "abcdef0123456789",
    updatedAt: "2026-07-13T12:00:00Z",
    content: "old content",
    ...over,
  };
}

interface Call {
  method: string;
  args: unknown[];
}

function makeClient(): { client: ManagedApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    listMemoryStores: (q?: unknown) => {
      calls.push({ method: "listMemoryStores", args: [q] });
      return Promise.resolve<Cursor<MemoryStore>>({ data: [makeStore()], nextCursor: null });
    },
    createMemoryStore: (body: unknown) => {
      calls.push({ method: "createMemoryStore", args: [body] });
      return Promise.resolve(makeStore({ id: "mem_new", displayTitle: (body as { displayTitle: string }).displayTitle }));
    },
    listMemories: (id: string, q?: unknown) => {
      calls.push({ method: "listMemories", args: [id, q] });
      const s: MemorySummary = { path: "notes.md", contentSha256: "abcdef0123456789", updatedAt: "2026-07-13T12:00:00Z" };
      return Promise.resolve<Cursor<MemorySummary>>({ data: [s], nextCursor: null });
    },
    getMemory: (id: string, path: string) => {
      calls.push({ method: "getMemory", args: [id, path] });
      return Promise.resolve(makeMemory({ path }));
    },
    updateMemory: (id: string, path: string, body: unknown) => {
      calls.push({ method: "updateMemory", args: [id, path, body] });
      return Promise.resolve(makeMemory({ path, content: (body as { content: string }).content, contentSha256: "newsha" + "0".repeat(10) }));
    },
  } as unknown as ManagedApiClient;
  return { client, calls };
}

function makeDeps(client: ManagedApiClient | undefined) {
  const notifies: { msg: string; type?: string }[] = [];
  const widgets: { key: string; lines: string[] }[] = [];
  const statuses: { key: string; text: string }[] = [];
  const inputs = vi.fn();
  return {
    deps: {
      ui: {
        notify: (msg: string, type?: "info" | "warning" | "error") => notifies.push({ msg, type }),
        setWidget: (key: string, lines: string[] | undefined) => lines && widgets.push({ key, lines }),
        setStatus: (key: string, text: string | undefined) => text && statuses.push({ key, text }),
        input: inputs,
      },
      createClient: () => client,
    },
    notifies,
    widgets,
    statuses,
    inputs,
  };
}

describe("/remote:memory commands (§24.5, §13)", () => {
  it("not configured → notifies and returns", async () => {
    const { deps, notifies } = makeDeps(undefined);
    await runMemoryList(deps);
    expect(notifies[0]?.msg).toMatch(/not configured/);
  });

  it("list renders store rows", async () => {
    const { client } = makeClient();
    const { deps, widgets } = makeDeps(client);
    await runMemoryList(deps);
    expect(widgets[0]?.lines[1]).toContain("mem_1");
    expect(widgets[0]?.lines[1]).toContain("Conventions");
  });

  it("show without path lists memories", async () => {
    const { client, calls } = makeClient();
    const { deps, widgets } = makeDeps(client);
    await runMemoryShow(deps, "mem_1");
    expect(calls[0]).toMatchObject({ method: "listMemories" });
    expect(widgets[0]?.lines[1]).toContain("notes.md");
  });

  it("show with path returns content", async () => {
    const { client, calls } = makeClient();
    const { deps, widgets } = makeDeps(client);
    await runMemoryShow(deps, "mem_1 notes.md");
    expect(calls[0]).toMatchObject({ method: "getMemory" });
    expect(widgets[0]?.lines).toContain("old content");
  });

  it("show without storeId → usage error", async () => {
    const { client, calls } = makeClient();
    const { deps, notifies } = makeDeps(client);
    await runMemoryShow(deps, "");
    expect(calls).toHaveLength(0);
    expect(notifies[0]?.msg).toMatch(/Usage/);
  });

  it("edit reads, prompts, updates with contentSha256", async () => {
    const { client, calls } = makeClient();
    const { deps, inputs, notifies } = makeDeps(client);
    inputs.mockResolvedValueOnce("new content");
    await runMemoryEdit(deps, "mem_1 notes.md");
    const updateCall = calls.find((c) => c.method === "updateMemory");
    expect(updateCall?.args[2]).toMatchObject({
      content: "new content",
      contentSha256: "abcdef0123456789",
    });
    expect(notifies.some((n) => n.msg.includes("Updated"))).toBe(true);
  });

  it("mount creates a store with chosen access", async () => {
    const { client, calls } = makeClient();
    const { deps, inputs } = makeDeps(client);
    inputs
      .mockResolvedValueOnce("My Store")
      .mockResolvedValueOnce("Be careful")
      .mockResolvedValueOnce("read_only");
    await runMemoryMount(deps);
    expect(calls[0]?.args[0]).toMatchObject({
      displayTitle: "My Store",
      instructions: "Be careful",
      access: "read_only",
    });
  });

  it("create-then-list round-trip", async () => {
    let stored: MemoryStore[] = [];
    const client = {
      createMemoryStore: (body: unknown) => {
        const s = makeStore({ id: "mem_new", displayTitle: (body as { displayTitle: string }).displayTitle });
        stored = [s];
        return Promise.resolve(s);
      },
      listMemoryStores: () => Promise.resolve<Cursor<MemoryStore>>({ data: stored, nextCursor: null }),
    } as unknown as ManagedApiClient;
    const mountDeps = makeDeps(client);
    mountDeps.inputs
      .mockResolvedValueOnce("My Store")
      .mockResolvedValueOnce("Be careful")
      .mockResolvedValueOnce("read_write");
    await runMemoryMount(mountDeps.deps);
    const listDeps = makeDeps(client);
    await runMemoryList(listDeps.deps);
    expect(listDeps.widgets[0]?.lines[1]).toContain("mem_new");
  });
});
