/**
 * @pi-managed/client — `/remote:memory` commands (spec §24.5, §13).
 * Cross-session memory stores mounted as volumes in the sandbox.
 *
 * Commands:
 * - `/remote:memory list` — list memory stores.
 * - `/remote:memory show <storeId> [path]` — list a store's memories, or show
 *   a specific memory's content when `path` is given.
 * - `/remote:memory edit <storeId> <path>` — update a memory's content
 *   (optimistic concurrency via contentSha256).
 * - `/remote:memory mount` — interactively create a memory store (the
 *   mountable unit referenced by sessions).
 *
 * The run* functions are decoupled from Pi types (deps-injected) so they can be
 * unit-tested against a mock client.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { MemoryStore } from "@pi-managed/contracts";
import { ApiClientError, type ManagedApiClient } from "../api-client.js";
import { buildClientFromContext } from "./remote.js";

/** UI slice these commands need (structural subset of ctx.ui). */
export interface MemoryUi {
  notify(msg: string, type?: "info" | "warning" | "error"): void;
  setWidget(key: string, lines: string[] | undefined): void;
  setStatus(key: string, text: string | undefined): void;
  input(title: string, placeholder?: string): Promise<string | undefined>;
}

/** Dependencies for the run* functions (all injectable for testing). */
export interface MemoryCommandDeps {
  ui: MemoryUi;
  /** Build an authenticated client, or undefined if the backend isn't configured. */
  createClient(): ManagedApiClient | undefined;
}

// --- helpers ----------------------------------------------------------------

function parseArgs(args: string): string[] {
  return args.trim().split(/\s+/).filter((t) => t !== "");
}

function notConfigured(ui: MemoryUi): void {
  ui.notify("Pi Managed Backend is not configured. Run /remote:config first.", "error");
}

function catchClientError(ui: MemoryUi, e: unknown, what: string): boolean {
  if (e instanceof ApiClientError) {
    ui.notify(`${what} failed: ${e.message}`, "error");
    return true;
  }
  return false;
}

// --- /remote:memory list ----------------------------------------------------

export async function runMemoryList(deps: MemoryCommandDeps): Promise<void> {
  const client = deps.createClient();
  if (!client) return notConfigured(deps.ui);
  let page;
  try {
    page = await client.listMemoryStores({ limit: 50 });
  } catch (e) {
    if (catchClientError(deps.ui, e, "Listing memory stores")) return;
    throw e;
  }
  if (page.data.length === 0) {
    deps.ui.notify("No memory stores.", "info");
    return;
  }
  const lines = ["Memory stores:"];
  for (const s of page.data) {
    lines.push(`  ${s.id} · ${s.status} · ${s.access} · ${s.displayTitle}`);
  }
  deps.ui.setWidget("pi-managed:memory", lines.slice(0, 50));
  deps.ui.setStatus("pi-managed", `${page.data.length} store(s)`);
}

// --- /remote:memory show <storeId> [path] ----------------------------------

export async function runMemoryShow(deps: MemoryCommandDeps, args: string): Promise<void> {
  const [storeId, path] = parseArgs(args);
  const client = deps.createClient();
  if (!client) return notConfigured(deps.ui);
  if (!storeId) {
    deps.ui.notify("Usage: /remote:memory show <storeId> [path]", "error");
    return;
  }
  if (path) {
    let memory;
    try {
      memory = await client.getMemory(storeId, path);
    } catch (e) {
      if (catchClientError(deps.ui, e, "Reading memory")) return;
      throw e;
    }
    const lines = [`Memory ${path} (store ${storeId}):`, memory.content];
    deps.ui.setWidget("pi-managed:memory", lines);
    deps.ui.setStatus("pi-managed", `${path}`);
    return;
  }
  let page;
  try {
    page = await client.listMemories(storeId, { limit: 50 });
  } catch (e) {
    if (catchClientError(deps.ui, e, "Listing memories")) return;
    throw e;
  }
  if (page.data.length === 0) {
    deps.ui.notify(`No memories in store ${storeId}.`, "info");
    return;
  }
  const lines = [`Memories in store ${storeId}:`];
  for (const m of page.data) {
    lines.push(`  ${m.path} · sha ${m.contentSha256.slice(0, 12)} · ${m.updatedAt}`);
  }
  deps.ui.setWidget("pi-managed:memory", lines.slice(0, 50));
  deps.ui.setStatus("pi-managed", `${page.data.length} memorie(s)`);
}

// --- /remote:memory edit <storeId> <path> ----------------------------------

export async function runMemoryEdit(deps: MemoryCommandDeps, args: string): Promise<void> {
  const [storeId, path] = parseArgs(args);
  const client = deps.createClient();
  if (!client) return notConfigured(deps.ui);
  if (!storeId || !path) {
    deps.ui.notify("Usage: /remote:memory edit <storeId> <path>", "error");
    return;
  }
  // Read current content first to capture its sha256 for optimistic concurrency.
  let current;
  try {
    current = await client.getMemory(storeId, path);
  } catch (e) {
    if (catchClientError(deps.ui, e, "Reading memory for edit")) return;
    throw e;
  }
  const content = await deps.ui.input(`New content for ${path}`, current.content);
  if (content === undefined) return;
  let updated;
  try {
    updated = await client.updateMemory(storeId, path, {
      content,
      contentSha256: current.contentSha256,
    });
  } catch (e) {
    if (catchClientError(deps.ui, e, "Updating memory")) return;
    throw e;
  }
  deps.ui.notify(
    `Updated memory ${path} (sha ${updated.contentSha256.slice(0, 12)}).`,
    "info",
  );
}

// --- /remote:memory mount --------------------------------------------------

export async function runMemoryMount(deps: MemoryCommandDeps): Promise<void> {
  const client = deps.createClient();
  if (!client) return notConfigured(deps.ui);
  const displayTitle = await deps.ui.input("Store title", "Project conventions");
  if (!displayTitle) return;
  const instructions = await deps.ui.input(
    "Instructions (optional, ≤4096 chars)",
    "Follow the existing patterns…",
  );
  const accessChoice = await deps.ui.input(
    "Access (read_write | read_only)",
    "read_write",
  );
  const access = accessChoice === "read_only" ? "read_only" : "read_write";
  let store: MemoryStore;
  try {
    store = await client.createMemoryStore({
      displayTitle,
      instructions: instructions || undefined,
      access,
    });
  } catch (e) {
    if (catchClientError(deps.ui, e, "Creating memory store")) return;
    throw e;
  }
  deps.ui.notify(`Created memory store ${store.id} (${store.access}).`, "info");
}

// --- Pi wiring -------------------------------------------------------------

/**
 * Register the `/remote:memory` command with Pi. RPC-invokable.
 */
export function registerMemoryCommands(pi: ExtensionAPI): void {
  const deps = (ctx: ExtensionCommandContext): MemoryCommandDeps => ({
    ui: ctx.ui,
    createClient: () => buildClientFromContext(ctx),
  });

  pi.registerCommand("remote:memory", {
    description: "Manage memory stores: /remote:memory <list|show|edit|mount> (spec §24.5, §13).",
    handler: async (args, ctx) => {
      const [sub, ...rest] = parseArgs(args);
      const restArgs = rest.join(" ");
      const d = deps(ctx);
      switch (sub) {
        case "list":
          return runMemoryList(d);
        case "show":
          return runMemoryShow(d, restArgs);
        case "edit":
          return runMemoryEdit(d, restArgs);
        case "mount":
          return runMemoryMount(d);
        default:
          d.ui.notify(
            "Usage: /remote:memory <list|show|edit|mount>",
            "error",
          );
      }
    },
  });
}
