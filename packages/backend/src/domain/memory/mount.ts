/**
 * Memory mount pipeline (WP-2.2, §13.1–13.3).
 *
 * At session creation (and ONLY then — §13.2) the referenced memory stores are
 * mounted into the sandbox as volumes. This module compiles the store list →
 * {@link VolumeMount} entries for the sandbox provision, derives the per-session
 * `mountPath`, emits the system-prompt note (§13.1), and provides the
 * write-back sync that flushes volume edits back to the object store on idle.
 *
 *  - object store → volume staged into the sandbox at `/mnt/memory/<slug>/`
 *    (§13.3); the `<slug>` is derived from the store's display title.
 *  - `access` (`read_write`/`read_only`) is enforced at the *mount* level: a
 *    `read_only` store compiles to a read-only bind mount, so an agent cannot
 *    write to it regardless of its tools.
 *  - write-back sync runs on idle (the session manager drives the timing): the
 *    volume's files are streamed back into the object store as new memory
 *    versions.
 */

import { ApiError } from "../errors.js";
import type {
  ObjectStore,
  SandboxHandle,
  SandboxProvider,
  VolumeMount,
} from "../ports.js";
import type { MemoryStore } from "@pi-managed/contracts";
import { slugify } from "./slug.js";
import { storeObjectKeyPrefix, fetchStoreRow, getMemoryStore } from "./store.js";
import { listMemories, getMemory, writeVersion } from "./memory.js";
import type { Pool, TenantCtx } from "../../infra/db/index.js";

/** Max memory stores mounted per session (§13.2). */
export const MAX_MEMORY_STORES_PER_SESSION = 8;

/** In-flight cap when staging a store's memories (PERF-11 — bounds the N+1 fan-out). */
const MEMORY_STAGE_CONCURRENCY = 8;

/**
 * Run `fn` over `items` with at most `limit` promises in flight (PERF-11). Order is not
 * preserved — staging writes distinct files, so concurrency is safe.
 */
async function forEachWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i]!);
      }
    },
  );
  await Promise.all(workers);
}

/** The guest mount path for a store (§13.3): `/mnt/memory/<slug>/`. */
export function mountPathFor(store: MemoryStore): string {
  const slug = slugify(store.displayTitle) || store.id;
  return `/mnt/memory/${slug}/`;
}

/**
 * Compile the memory-store list → {@link VolumeMount} entries for a sandbox
 * provision (§13.3). `read_only` stores compile to read-only mounts so an agent
 * cannot write to them at the mount level (§13.2). Enforces the 8-stores-per-
 * session cap (§13.2). Attach happens at session creation only (§13.2); this
 * function is the single entry point for that wiring.
 *
 * The volume `source` is the store's object-store prefix (derived from the
 * tenant + store id, §3.6); the sandbox provider stages the contents under it.
 */
export function mountMemoryStores(
  tenantCtx: TenantCtx,
  stores: MemoryStore[],
): VolumeMount[] {
  if (stores.length > MAX_MEMORY_STORES_PER_SESSION) {
    throw new ApiError(
      422,
      "invalid_request",
      `a session may mount at most ${MAX_MEMORY_STORES_PER_SESSION} memory stores (§13.2)`,
    );
  }
  const mounts: VolumeMount[] = [];
  const seen = new Set<string>();
  for (const store of stores) {
    const guestPath = mountPathFor(store);
    if (seen.has(guestPath)) {
      throw new ApiError(
        422,
        "invalid_request",
        `duplicate memory mount path: ${guestPath} (rename a store)`,
      );
    }
    seen.add(guestPath);
    mounts.push({
      guestPath,
      source: storeObjectKeyPrefix(tenantCtx.tenantId, store.id),
      readOnly: store.access === "read_only",
    });
  }
  return mounts;
}

/**
 * The system-prompt note for a mounted store (§13.1). One note per mount,
 * appended to the system prompt so the model knows the store exists, where it
 * is mounted, whether it is read-only, and the store's instructions.
 */
export function systemPromptNoteFor(store: MemoryStore): string {
  const access = store.access === "read_only" ? "read-only" : "read-write";
  const lines = [
    `Memory store "${store.displayTitle}" is mounted ${access} at ${mountPathFor(store)}.`,
  ];
  if (store.instructions) {
    lines.push(`Instructions: ${store.instructions}`);
  }
  if (store.access === "read_only") {
    lines.push("This store is read-only; writes will fail at the mount level.");
  }
  return lines.join(" ");
}

/** All system-prompt notes for a set of mounted stores (§13.1). */
export function systemPromptNotes(stores: MemoryStore[]): string[] {
  return stores.map(systemPromptNoteFor);
}

// ---------------------------------------------------------------------------
// Volume staging + write-back (§13.1)
// ---------------------------------------------------------------------------

/**
 * A read/write handle over a mounted memory volume (the staged directory the
 * agent sees at `/mnt/memory/<slug>/`). Implementations:
 *  - {@link InMemoryVolumeStore} — test fake (always runs).
 *  - a real provider-backed impl via sandbox `exec` (`ls`/`cat`/`tee`) —
 *    `@kvm`-gated in tests.
 *
 * The volume is *path-structured* (a memory's `path` maps to a file relative to
 * the volume root); staging populates it from live memories, write-back drains
 * it into new memory versions.
 */
export interface VolumeStore {
  /** List file paths relative to the volume root. */
  listFiles(): Promise<string[]>;
  /** Read a file's content (relative path). */
  readFile(path: string): Promise<Buffer>;
  /** Write a file's content (relative path) — staging + agent edits. */
  writeFile(path: string, content: Buffer): Promise<void>;
}

/** In-memory {@link VolumeStore} — the test fake (no sandbox needed). */
export class InMemoryVolumeStore implements VolumeStore {
  private files = new Map<string, Buffer>();
  /** Test seam: simulate the agent writing a file into the mounted volume. */
  write(path: string, content: Buffer | string): void {
    this.files.set(path, Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"));
  }
  async listFiles(): Promise<string[]> {
    return [...this.files.keys()].sort();
  }
  async readFile(path: string): Promise<Buffer> {
    const f = this.files.get(path);
    if (!f) throw new Error(`volume file not found: ${path}`);
    return f;
  }
  async writeFile(path: string, content: Buffer): Promise<void> {
    this.files.set(path, content);
  }
}

/**
 * Stage a store's live memories into a volume (provision-time, §13.1): for each
 * live head, write `<path> → content` into the volume so the agent sees the
 * current contents at `/mnt/memory/<slug>/<path>`. Read-only stores are staged
 * identically (the read-only enforcement is at the mount, not here).
 */
export async function stageMemoryVolume(
  pool: Pool,
  tenantCtx: TenantCtx,
  objectStore: ObjectStore,
  storeId: string,
  volume: VolumeStore,
): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await listMemories(pool, tenantCtx, storeId, { limit: 200, cursor });
    // PERF-11: each memory is an independent DB read + object get + sandbox exec; fan them
    // out with a small concurrency cap instead of awaiting each in series.
    await forEachWithConcurrency(page.data, MEMORY_STAGE_CONCURRENCY, async (m) => {
      const mem = await getMemory(pool, tenantCtx, objectStore, storeId, m.path);
      await volume.writeFile(m.path, Buffer.from(mem.content, "utf8"));
    });
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
}

/**
 * Write-back sync on idle (§13.1): drain the mounted volume's files back into
 * the object store as new memory versions. For each file, append a new head
 * version at that path (no precondition — this is a system-initiated sync).
 * This is what makes a second session sharing the store observe the first
 * session's edits.
 */
export async function syncMemoryVolumeBack(opts: {
  pool: Pool;
  tenantCtx: TenantCtx;
  objectStore: ObjectStore;
  storeId: string;
  volume: VolumeStore;
}): Promise<void> {
  const { pool, tenantCtx, objectStore, storeId, volume } = opts;
  const store = await fetchStoreRow(pool, tenantCtx, storeId);
  if (!store) {
    throw new ApiError(404, "not_found", `memory store not found: ${storeId}`);
  }
  const files = await volume.listFiles();
  for (const path of files) {
    const content = (await volume.readFile(path)).toString("utf8");
    await writeVersion(
      pool,
      tenantCtx,
      objectStore,
      storeId,
      store.objectKeyPrefix,
      path,
      content,
    );
  }
}

// ---------------------------------------------------------------------------
// Sandbox-backed volume + the session-start service (R6.5a)
// ---------------------------------------------------------------------------

/**
 * A memory path is a relative file path inside the volume. It is caller-controlled
 * (the Memory API), so it is validated before it is ever interpolated into a guest
 * shell command: only `[A-Za-z0-9._/-]`, no leading `/`, no `..` segment.
 */
function assertSafeVolumePath(path: string): void {
  if (
    path === "" ||
    path.startsWith("/") ||
    !/^[A-Za-z0-9._/-]+$/.test(path) ||
    path.split("/").includes("..")
  ) {
    throw new ApiError(422, "invalid_request", `unsafe memory path: ${path}`);
  }
}

/**
 * A {@link VolumeStore} over a store's mounted volume in a LIVE sandbox (§13.1). Files
 * are listed/read/written through `SandboxProvider.exec` at the guest mount path, so
 * staging and write-back see exactly what the agent sees. Content crosses the boundary
 * base64-encoded (a `[A-Za-z0-9+/=]` alphabet) — never interpolated raw into a shell.
 *
 * A `read_only` store's mount rejects the write at the mount level; the runtime does not
 * even attempt a write-back for one (see `ManagedSessionRuntime.syncMemoryVolumes`).
 */
export function createSandboxVolumeStore(sandbox: {
  provider: SandboxProvider;
  handle: SandboxHandle;
  guestPath: string;
}): VolumeStore {
  const { provider, handle } = sandbox;
  // Normalize `/mnt/memory/<slug>/` → `/mnt/memory/<slug>` (no trailing slash).
  const root = sandbox.guestPath.replace(/\/+$/, "");
  return {
    async listFiles(): Promise<string[]> {
      const r = await provider.exec(handle, {
        cmd: ["find", root, "-type", "f", "-printf", "%P\\n"],
      });
      if (r.exitCode !== 0) return [];
      return r.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .sort();
    },
    async readFile(path: string): Promise<Buffer> {
      assertSafeVolumePath(path);
      const r = await provider.exec(handle, {
        cmd: ["cat", `${root}/${path}`],
      });
      if (r.exitCode !== 0) {
        throw new Error(`volume file not found: ${path}`);
      }
      return Buffer.from(r.stdout, "utf8");
    },
    async writeFile(path: string, content: Buffer): Promise<void> {
      assertSafeVolumePath(path);
      const dest = `${root}/${path}`;
      const dir = dest.slice(0, dest.lastIndexOf("/"));
      const b64 = content.toString("base64");
      const r = await provider.exec(handle, {
        cmd: [
          "sh",
          "-c",
          `mkdir -p ${dir} && printf %s ${b64} | base64 -d > ${dest}`,
        ],
      });
      if (r.exitCode !== 0) {
        throw new Error(
          `volume write failed for ${path} (exit ${r.exitCode}): ${r.stderr.trim()}`,
        );
      }
    },
  };
}

/**
 * The pool + object-store backed memory-mount service (R6.5a) the composition root
 * injects into every {@link ManagedSessionRuntime}. Structurally satisfies the session
 * manager's `MemoryMountService` seam (declared there so neither domain imports the
 * other).
 *
 * A store id the tenant does not own (or an archived one) simply does not resolve —
 * `resolveStores` drops it, so a stale environment mount can never stage another
 * tenant's memory (§27.1).
 */
export function createMemoryMountService(deps: {
  pool: Pool;
  objectStore: ObjectStore;
}) {
  const { pool, objectStore } = deps;
  return {
    async resolveStores(tenantId: string, storeIds: string[]): Promise<MemoryStore[]> {
      const tenantCtx: TenantCtx = { tenantId };
      const out: MemoryStore[] = [];
      for (const id of storeIds) {
        const store = await getMemoryStore(pool, tenantCtx, id);
        if (store) out.push(store);
      }
      return out;
    },
    volumeFor(
      _store: MemoryStore,
      sandbox: {
        provider: SandboxProvider;
        handle: SandboxHandle;
        guestPath: string;
      },
    ): VolumeStore {
      return createSandboxVolumeStore(sandbox);
    },
    async stage(
      tenantId: string,
      store: MemoryStore,
      volume: VolumeStore,
    ): Promise<void> {
      await stageMemoryVolume(pool, { tenantId }, objectStore, store.id, volume);
    },
    async syncBack(
      tenantId: string,
      store: MemoryStore,
      volume: VolumeStore,
    ): Promise<void> {
      await syncMemoryVolumeBack({
        pool,
        tenantCtx: { tenantId },
        objectStore,
        storeId: store.id,
        volume,
      });
    },
  };
}
