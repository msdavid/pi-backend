/**
 * WP-2.6 tests — memory `remote_*` tool definitions + create-then-list round-trip.
 */
import { describe, it, expect } from "vitest";
import { createMemoryTools } from "./memory-tools.js";
import type { ManagedApiClient } from "../api-client.js";
import type { Cursor, Memory, MemoryStore } from "@pi-managed/contracts";

interface Call {
  method: string;
  args: unknown[];
}

function makeClient(): { client: ManagedApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    listMemoryStores: () => {
      calls.push({ method: "listMemoryStores", args: [] });
      return Promise.resolve<Cursor<MemoryStore>>({ data: [], nextCursor: null });
    },
    createMemoryStore: (body: unknown) => {
      calls.push({ method: "createMemoryStore", args: [body] });
      return Promise.resolve({
        id: "mem_new",
        access: (body as { access: string }).access,
        status: "active",
        displayTitle: (body as { displayTitle: string }).displayTitle,
        instructions: null,
        mountPath: null,
        createdAt: "2026-07-13T12:00:00Z",
        updatedAt: "2026-07-13T12:00:00Z",
      });
    },
    getMemory: (id: string, path: string) => {
      calls.push({ method: "getMemory", args: [id, path] });
      return Promise.resolve({
        path,
        contentSha256: "abcdef0123456789",
        updatedAt: "2026-07-13T12:00:00Z",
        content: "the content",
      });
    },
    updateMemory: (id: string, path: string, body: unknown) => {
      calls.push({ method: "updateMemory", args: [id, path, body] });
      return Promise.resolve({
        path,
        contentSha256: "newsha0000000000",
        updatedAt: "2026-07-13T12:00:00Z",
        content: (body as { content: string }).content,
      });
    },
  } as unknown as ManagedApiClient;
  return { client, calls };
}

function makeTools() {
  const { client, calls } = makeClient();
  const tools = createMemoryTools({ client: () => client });
  return { tools, calls, client };
}

describe("WP-2.6 memory tools", () => {
  it("defines 4 tools with detailed descriptions (>200 chars)", () => {
    const { tools } = makeTools();
    expect(tools).toHaveLength(4);
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "remote_memory_list",
        "remote_memory_show",
        "remote_memory_edit",
        "remote_memory_mount",
      ]),
    );
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(200);
    }
  });

  it("remote_memory_show returns content + sha", async () => {
    const { tools, calls } = makeTools();
    const show = tools.find((t) => t.name === "remote_memory_show")!;
    const res = await show.execute(
      "tc1",
      { storeId: "mem_1", path: "notes.md" },
      undefined,
      undefined,
      undefined as unknown,
    );
    expect(res.details).toMatchObject({
      path: "notes.md",
      contentSha256: "abcdef0123456789",
    });
    expect(calls[0]).toMatchObject({ method: "getMemory", args: ["mem_1", "notes.md"] });
  });

  it("remote_memory_edit forwards content + contentSha256", async () => {
    const { tools, calls } = makeTools();
    const edit = tools.find((t) => t.name === "remote_memory_edit")!;
    await edit.execute(
      "tc1",
      { storeId: "mem_1", path: "notes.md", content: "new", contentSha256: "abcdef0123456789" },
      undefined,
      undefined,
      undefined as unknown,
    );
    const call = calls.find((c) => c.method === "updateMemory");
    expect(call?.args[2]).toMatchObject({
      content: "new",
      contentSha256: "abcdef0123456789",
    });
  });

  it("remote_memory_mount creates a store (read_only when chosen)", async () => {
    const { tools, calls } = makeTools();
    const mount = tools.find((t) => t.name === "remote_memory_mount")!;
    const res = await mount.execute(
      "tc1",
      { displayTitle: "Conventions", instructions: "be careful", access: "read_only" },
      undefined,
      undefined,
      undefined as unknown,
    );
    expect(res.details).toMatchObject({ storeId: "mem_new", access: "read_only" });
    expect(calls[0]?.args[0]).toMatchObject({
      displayTitle: "Conventions",
      instructions: "be careful",
      access: "read_only",
    });
  });

  it("remote_memory_mount defaults to read_write", async () => {
    const { tools, calls } = makeTools();
    const mount = tools.find((t) => t.name === "remote_memory_mount")!;
    await mount.execute(
      "tc1",
      { displayTitle: "X" },
      undefined,
      undefined,
      undefined as unknown,
    );
    expect((calls[0].args[0] as { access: string }).access).toBe("read_write");
  });

  it("create-then-list round-trip", async () => {
    let stored: MemoryStore[] = [];
    const client = {
      createMemoryStore: (body: unknown) => {
        const s = {
          id: "mem_new",
          access: "read_write",
          status: "active",
          displayTitle: (body as { displayTitle: string }).displayTitle,
          instructions: null,
          mountPath: null,
          createdAt: "2026-07-13T12:00:00Z",
          updatedAt: "2026-07-13T12:00:00Z",
        } as unknown as MemoryStore;
        stored = [s];
        return Promise.resolve(s);
      },
      listMemoryStores: () =>
        Promise.resolve<Cursor<MemoryStore>>({ data: stored, nextCursor: null }),
    } as unknown as ManagedApiClient;
    const tools = createMemoryTools({ client: () => client });
    const mount = tools.find((t) => t.name === "remote_memory_mount")!;
    await mount.execute(
      "tc1",
      { displayTitle: "Conventions" },
      undefined,
      undefined,
      undefined as unknown,
    );
    const list = tools.find((t) => t.name === "remote_memory_list")!;
    const res = await list.execute("tc1", {}, undefined, undefined, undefined as unknown);
    expect((res.details as { stores: MemoryStore[] }).stores[0].id).toBe("mem_new");
  });

  it("throws if backend not configured", async () => {
    const tools = createMemoryTools({ client: () => null });
    const list = tools.find((t) => t.name === "remote_memory_list")!;
    await expect(
      list.execute("tc1", {}, undefined, undefined, undefined as unknown),
    ).rejects.toThrow(/not configured/);
  });
});

// satisfy unused-import linters for type-only references
void (0 as unknown as Memory);
