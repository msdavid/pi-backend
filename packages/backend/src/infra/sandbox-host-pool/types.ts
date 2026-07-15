/**
 * Multi-host sandbox pool shared types (WP-4.3, §7.2).
 *
 * Infra-scoped control-plane state — NOT tenant-scoped. The host pool is shared across
 * all tenants (§7.2). See `docs/multi-host-design.md`.
 */

/** A KVM-capable host in the sandbox pool. */
export interface SandboxHost {
  /** `host_…` prefixed id (§6.6). */
  id: string;
  /** Host agent endpoint, e.g. `https://kvm-1.internal:8443`. */
  endpoint: string;
  /** Total CPU capacity in cores. */
  cpus: number;
  /** Total memory capacity in MiB. */
  memoryMiB: number;
  /** Rotation status. `chooseHost` only considers `healthy` hosts. */
  status: "healthy" | "unhealthy" | "drained";
  /** Placement constraints (e.g. `{"gpu":"true"}`), §4.2. */
  labels: Record<string, string>;
  /** Last successful heartbeat timestamp (ISO). Null until first probe. */
  lastHeartbeat: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Reason a host was marked unhealthy (auditable, machine-readable). */
export interface UnhealthyReason {
  /** e.g. `healthz_failed`, `healthz_timeout`. */
  type: string;
  /** Human-readable detail (no secrets). */
  detail?: string;
  /** ISO timestamp of the transition. */
  at: string;
}

/**
 * A host's current placement load (ROB-17): how many microVMs it runs and the CPU/memory
 * they collectively reserve. `chooseHost` subtracts this from the host's TOTAL capacity to
 * get real remaining headroom (admission control), instead of comparing a new spec against
 * total capacity and oversubscribing.
 */
export interface HostLoad {
  /** Number of microVMs currently placed on the host. */
  count: number;
  /** Sum of the placed VMs' `cpus`. */
  cpus: number;
  /** Sum of the placed VMs' `memoryMiB`. */
  memoryMiB: number;
}

/**
 * The host-registry surface consumers depend on (so they can take an in-memory
 * fake in tests). {@link HostRegistry} (registry.ts) implements this against Postgres.
 */
export interface HostRegistryPort {
  listHosts(healthyOnly?: boolean): Promise<SandboxHost[]>;
  getHost(id: string): Promise<SandboxHost | undefined>;
  /** Per-host placement load (count + reserved cpus/memory) for admission control (§4.2). */
  placementUsage(): Promise<Map<string, HostLoad>>;
  /**
   * Record (or reconcile) a placement. `resources` is the VM's footprint, stored so
   * {@link placementUsage} can sum it; omit it on a pure ownership reconcile (boot re-attach)
   * to preserve the row's existing footprint.
   */
  recordPlacement(
    sandboxName: string,
    hostId: string,
    resources?: { cpus: number; memoryMiB: number },
  ): Promise<void>;
  getOwner(sandboxName: string): Promise<string | undefined>;
  removePlacement(sandboxName: string): Promise<void>;
}

/** Liveness-only registry surface (markHealthy/markUnhealthy/heartbeat). */
export interface LivenessRegistryPort {
  listHosts(healthyOnly?: boolean): Promise<SandboxHost[]>;
  markHealthy(id: string): Promise<void>;
  markUnhealthy(id: string, reason: UnhealthyReason): Promise<void>;
  updateHeartbeat(id: string, at?: Date): Promise<void>;
}
