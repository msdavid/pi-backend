/**
 * Shared vs isolated execution modes (WP-3.1, spec §18.4).
 *
 * - `shared` — all threads share ONE sandbox handle + ONE vault binding set. The
 *   model / system prompt / tools / MCP / skills remain per-thread (they come from
 *   each thread's agent config), but the execution environment + secrets are shared.
 * - `isolated` — each thread gets its OWN sandbox handle + its OWN resolved config
 *   (model / system prompt / tools / MCP / skills NOT shared). Vault bindings are
 *   resolved per-thread.
 *
 * The {@link SandboxAllocator} port abstracts sandbox provisioning so the coordinator
 * stays testable with a fake (no real microVM). Vault first-match-wins across threads
 * (§12.6) is honored by resolving bindings once (shared) or per-thread (isolated);
 * the secret store already implements first-match-wins across the listed vaults.
 */

import type { SandboxHandle } from "../ports.js";
import type { MultiagentMode, ResolvedThreadMaterial } from "./types.js";

/** Options to allocate a sandbox for a thread. */
export interface AllocateSandboxOptions {
  mode: MultiagentMode;
  threadId: string;
  /** The material for this thread (carries env + vault ids). */
  material: ResolvedThreadMaterial;
}

/** Result of a sandbox allocation. */
export interface AllocatedSandbox {
  /** Opaque handle (shared mode: the same instance across threads). */
  handle: SandboxHandle;
  /** Whether this handle is shared across threads (affects teardown ownership). */
  shared: boolean;
}

/**
 * Allocates sandboxes for threads. Implementations:
 * - {@link SharedSandboxAllocator} — provisions one handle, returns it for every
 *   thread (shared mode, §18.4).
 * - {@link IsolatedSandboxAllocator} — provisions a fresh handle per thread
 *   (isolated mode, §18.4).
 *
 * Tests inject a fake (e.g. returning a sentinel handle) — no real provider needed.
 */
export interface SandboxAllocator {
  allocate(opts: AllocateSandboxOptions): Promise<AllocatedSandbox>;
  /** Release a handle. Shared handles are released once by the coordinator. */
  release(handle: SandboxHandle): Promise<void>;
}

/**
 * Shared-mode allocator: provisions exactly one sandbox on first use and returns it
 * for every subsequent thread. The coordinator releases it once at teardown.
 */
export class SharedSandboxAllocator implements SandboxAllocator {
  private cached: AllocatedSandbox | undefined;
  private readonly provision: () => Promise<SandboxHandle>;
  private readonly destroy: (handle: SandboxHandle) => Promise<void>;

  constructor(deps: {
    provision: () => Promise<SandboxHandle>;
    destroy: (handle: SandboxHandle) => Promise<void>;
  }) {
    this.provision = deps.provision;
    this.destroy = deps.destroy;
  }

  async allocate(): Promise<AllocatedSandbox> {
    if (!this.cached) {
      this.cached = { handle: await this.provision(), shared: true };
    }
    return this.cached;
  }

  async release(handle: SandboxHandle): Promise<void> {
    if (this.cached && this.cached.handle === handle) {
      await this.destroy(handle);
      this.cached = undefined;
    }
  }
}

/**
 * Isolated-mode allocator: provisions a fresh sandbox per thread. Each thread owns
 * its handle and the coordinator releases it when the thread disposes.
 */
export class IsolatedSandboxAllocator implements SandboxAllocator {
  private readonly provision: () => Promise<SandboxHandle>;
  private readonly destroy: (handle: SandboxHandle) => Promise<void>;

  constructor(deps: {
    provision: () => Promise<SandboxHandle>;
    destroy: (handle: SandboxHandle) => Promise<void>;
  }) {
    this.provision = deps.provision;
    this.destroy = deps.destroy;
  }

  async allocate(): Promise<AllocatedSandbox> {
    return { handle: await this.provision(), shared: false };
  }

  async release(handle: SandboxHandle): Promise<void> {
    await this.destroy(handle);
  }
}

/**
 * A fake allocator for tests: returns a stable sentinel handle per call (isolated)
 * or the same handle (shared). Records allocations for assertions.
 */
export class FakeSandboxAllocator implements SandboxAllocator {
  readonly allocated: AllocateSandboxOptions[] = [];
  /** Handles passed to {@link release}, in order (leak assertions, R6.4). */
  readonly released: SandboxHandle[] = [];
  private counter = 0;
  private sharedHandle: SandboxHandle | undefined;

  constructor(private readonly mode: MultiagentMode) {}

  async allocate(opts: AllocateSandboxOptions): Promise<AllocatedSandbox> {
    this.allocated.push(opts);
    if (this.mode === "shared") {
      if (!this.sharedHandle) this.sharedHandle = sentinel(this.counter++);
      return { handle: this.sharedHandle, shared: true };
    }
    return { handle: sentinel(this.counter++), shared: false };
  }

  async release(handle: SandboxHandle): Promise<void> {
    this.released.push(handle);
  }

  /** Number of distinct handles provisioned. */
  get distinctHandles(): number {
    return this.mode === "shared" ? (this.sharedHandle ? 1 : 0) : this.allocated.length;
  }

  /** Handles provisioned but never released (must be 0 after coordinator dispose). */
  get leakedHandles(): number {
    return this.distinctHandles - new Set(this.released).size;
  }
}

function sentinel(n: number): SandboxHandle {
  // SandboxHandle is an opaque interface; a minimal object satisfies structural typing.
  return {
    id: `fake-sandbox-${n}`,
    name: `fake-sandbox-${n}`,
    labels: { tenant: "test", session: `thread-${n}` },
  };
}
