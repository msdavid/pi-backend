/**
 * WP-2.6 — Agent-facing `remote_*` tools for memory stores.
 *
 * Spec §24.6, §13. Cross-session memory mounted as a volume in the sandbox.
 * Memory stores persist knowledge across sessions (project conventions, past
 * decisions, long-running context) and are mounted into the agent's sandbox
 * filesystem. Individual memories are versioned (immutable audit trail).
 */

import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ManagedApiClient } from "../api-client.js";

/** Options injected from the extension entry point. */
export interface MemoryToolsOptions {
  client: () => ManagedApiClient | null;
}

// ---------------------------------------------------------------------------
// Tool parameter schemas (TypeBox)
// ---------------------------------------------------------------------------

const MemoryListParams = Type.Object({
  limit: Type.Optional(Type.Number({ description: "Page size (default 50, max 200)." })),
});

const MemoryShowParams = Type.Object({
  storeId: Type.String({ description: "Memory store ID (mem_…)." }),
  path: Type.String({ description: "Memory path within the store to retrieve (with content)." }),
});

const MemoryEditParams = Type.Object({
  storeId: Type.String({ description: "Memory store ID (mem_…)." }),
  path: Type.String({ description: "Memory path to update." }),
  content: Type.String({ description: "New full content for the memory (≤100 kB)." }),
  contentSha256: Type.Optional(Type.String({ description: "Optimistic-concurrency precondition: the stored hash must still match. Omit to force the update; supply the hash from remote_memory_show to detect concurrent edits." })),
});

const MemoryMountParams = Type.Object({
  displayTitle: Type.String({ description: "Human-readable store title." }),
  instructions: Type.Optional(Type.String({ description: "Agent-facing instructions for using this memory (≤4096 chars)." })),
  access: Type.Optional(Type.String({ description: "Access mode: read_write (default) or read_only for untrusted input." })),
});

// ---------------------------------------------------------------------------
// Tool descriptions — extremely detailed (§11.2).
// ---------------------------------------------------------------------------

const MEMORY_LIST_DESC = `List the tenant's memory stores — cross-session knowledge persisted on the backend and mounted as a volume inside agent sandbox filesystems. Use this to discover what long-term context is available before starting a session (so you can reference the right store), to audit which stores exist, or to find a store whose memories you want to read or edit. Returns each store's ID, title, access mode (read_write or read_only), and status. Paginated by cursor. To read a specific memory's content within a store, use remote_memory_show.`;

const MEMORY_SHOW_DESC = `Retrieve a single memory entry (with its full content) from a memory store by path. Use this to read project conventions, past decisions, or any persisted knowledge the agent or a previous session wrote to the store — for example, to recall an agreed-upon pattern before refactoring, or to inspect why a prior session made a choice. The returned content includes the current contentSha256, which you should pass back to remote_memory_edit to detect concurrent edits (optimistic concurrency: the update fails with 409 if another writer changed the memory first).`;

const MEMORY_EDIT_DESC = `Update the content of an existing memory entry in a memory store, creating a new immutable version (the audit trail of prior versions is retained). Pass the contentSha256 from remote_memory_show to enable optimistic concurrency — if another writer edited the memory since you read it, the update fails with 409 and you must re-read and retry. Use this to keep persisted knowledge current: append new conventions, correct outdated instructions, or refine guidance after learning something in the current session. New content replaces the old in full (no merge). Individual memories are capped at 100 kB (~25k tokens).`;

const MEMORY_MOUNT_DESC = `Create a new memory store on the backend — the mountable unit of cross-session memory that the sandbox mounts as a volume at session creation. Use this to establish a persistent knowledge base for a project, team, or long-running task that should survive across sessions: store conventions, decisions, FAQs, or accumulated context so future sessions start informed instead of from scratch. Choose read_write for normal stores or read_only when the memory may contain untrusted input that the agent must not modify. Returns the new store ID; write memories into it via the REST memory-create endpoint or future tooling.`;

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createMemoryTools(opts: MemoryToolsOptions): ReturnType<typeof defineTool>[] {
  const { client } = opts;

  const requireClient = (): ManagedApiClient => {
    const c = client();
    if (!c) throw new Error("Pi Managed backend is not configured. Run /remote:config first.");
    return c;
  };

  const memoryList = defineTool({
    name: "remote_memory_list",
    label: "Remote memory list",
    description: MEMORY_LIST_DESC,
    parameters: MemoryListParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const c = requireClient();
      const res = await c.listMemoryStores({ limit: params.limit });
      return {
        content: [{ type: "text", text: `${res.data.length} memory store(s).` }],
        details: { stores: res.data },
      };
    },
  });

  const memoryShow = defineTool({
    name: "remote_memory_show",
    label: "Remote memory show",
    description: MEMORY_SHOW_DESC,
    parameters: MemoryShowParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const c = requireClient();
      const memory = await c.getMemory(params.storeId, params.path);
      return {
        content: [{ type: "text", text: `Memory ${params.path} (store ${params.storeId}):\n${memory.content}` }],
        details: { path: memory.path, contentSha256: memory.contentSha256, updatedAt: memory.updatedAt },
      };
    },
  });

  const memoryEdit = defineTool({
    name: "remote_memory_edit",
    label: "Remote memory edit",
    description: MEMORY_EDIT_DESC,
    parameters: MemoryEditParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const c = requireClient();
      const updated = await c.updateMemory(params.storeId, params.path, {
        content: params.content,
        contentSha256: params.contentSha256,
      });
      return {
        content: [{ type: "text", text: `Updated memory ${params.path} (sha ${updated.contentSha256.slice(0, 12)}).` }],
        details: { path: updated.path, contentSha256: updated.contentSha256, updatedAt: updated.updatedAt },
      };
    },
  });

  const memoryMount = defineTool({
    name: "remote_memory_mount",
    label: "Remote memory mount",
    description: MEMORY_MOUNT_DESC,
    parameters: MemoryMountParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const c = requireClient();
      const access = params.access === "read_only" ? "read_only" : "read_write";
      const store = await c.createMemoryStore(
        {
          displayTitle: params.displayTitle,
          instructions: params.instructions,
          access,
        },
        `remote_memory_mount_${Date.now()}`,
      );
      return {
        content: [{ type: "text", text: `Created memory store ${store.id} (${store.access}).` }],
        details: { storeId: store.id, access: store.access, status: store.status },
      };
    },
  });

  return [memoryList, memoryShow, memoryEdit, memoryMount];
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Register the memory `remote_*` tools. Exported for explicit wiring (§24.6). */
export function registerMemoryTools(pi: ExtensionAPI, opts: MemoryToolsOptions): void {
  for (const tool of createMemoryTools(opts)) pi.registerTool(tool);
}
