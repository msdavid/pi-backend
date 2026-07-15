/**
 * Session memory-volume lifecycle (R6.5a, §13.1) — extracted from
 * {@link ManagedSessionRuntime}.
 *
 * Owns staging a session's mounted memory stores into their live sandbox volumes at wake,
 * and draining READ-WRITE volumes back into new memory versions on idle. Constructed once
 * the live sandbox handle exists; the runtime resolves WHICH stores are mounted (that needs
 * no handle) and hands them to `stage` / `syncBack`.
 */

import type { MemoryStore } from "@pi-managed/contracts";
import type { SandboxHandle, SandboxProvider } from "../ports.js";
import type { MemoryMountService, SessionVolumeStore } from "./types.js";
import { mountPathFor } from "../memory/mount.js";

export class SessionMemoryVolumes {
  constructor(
    private readonly memory: MemoryMountService,
    private readonly provider: SandboxProvider,
    private readonly handle: SandboxHandle,
    private readonly tenantId: string,
  ) {}

  /** A read/write view over a store's mounted volume in the live sandbox. */
  private volumeFor(store: MemoryStore): SessionVolumeStore {
    return this.memory.volumeFor(store, {
      provider: this.provider,
      handle: this.handle,
      guestPath: mountPathFor(store),
    });
  }

  /** Stage every mounted store's live memories into its volume (post-provision, §13.1). */
  async stage(stores: MemoryStore[]): Promise<void> {
    for (const store of stores) {
      await this.memory.stage(this.tenantId, store, this.volumeFor(store));
    }
  }

  /**
   * Write-back on idle (§13.1): drain each READ-WRITE volume back into new memory versions
   * so a second session sharing the store observes this session's edits. A `read_only`
   * store is skipped (its mount rejects writes anyway). Best-effort per store: a
   * memory-service failure must not crash the turn's settlement.
   */
  async syncBack(stores: MemoryStore[]): Promise<void> {
    for (const store of stores) {
      if (store.access === "read_only") continue;
      try {
        await this.memory.syncBack(this.tenantId, store, this.volumeFor(store));
      } catch {
        /* best-effort: a write-back failure must not crash the turn */
      }
    }
  }
}
