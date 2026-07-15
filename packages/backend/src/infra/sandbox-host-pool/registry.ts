/**
 * Host-pool registry (WP-4.3, §7.2).
 *
 * Persists the KVM-capable host pool in Postgres (`sandbox_hosts`,
 * `sandbox_host_placements`). Infra-scoped — NOT tenant-scoped (§7.2). The registry is
 * the single source of truth for which hosts exist and their rotation status; placement
 * (`placement.ts`) and liveness (`liveness.ts`) read through it.
 *
 * See `docs/multi-host-design.md`.
 */

import type { Pool } from "../db/pool.js";
import { query } from "../db/pool.js";
import type { SandboxHost, UnhealthyReason, HostRegistryPort, HostLoad } from "./types.js";

/** Input to register or upsert a host. */
export interface RegisterHostInput {
  id: string;
  endpoint: string;
  cpus: number;
  memoryMiB: number;
  labels?: Record<string, string>;
}

/** Thrown when a host lookup misses. */
export class HostNotFoundError extends Error {
  constructor(public readonly hostId: string) {
    super(`Host not found: ${hostId}`);
    this.name = "HostNotFoundError";
  }
}

/** Row shape of `sandbox_hosts`. */
interface HostRow {
  id: string;
  endpoint: string;
  cpus: number;
  memory_mib: number;
  status: string;
  labels: Record<string, string>;
  last_heartbeat: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Row shape of `sandbox_host_placements`. */
interface PlacementRow {
  sandbox_name: string;
  host_id: string;
}

/**
 * Postgres-backed registry of sandbox hosts. Construct once; share across the
 * `MultiHostSandboxProvider` and `LivenessMonitor`.
 */
export class HostRegistry implements HostRegistryPort {
  constructor(private readonly pool: Pool) {}

  /** Register (or upsert capacity/labels for) a host. New hosts start `healthy`. */
  async registerHost(input: RegisterHostInput): Promise<SandboxHost> {
    await query(this.pool, `
      INSERT INTO sandbox_hosts (id, endpoint, cpus, memory_mib, status, labels)
      VALUES ($1, $2, $3, $4, 'healthy', $5)
      ON CONFLICT (id) DO UPDATE SET
        endpoint   = EXCLUDED.endpoint,
        cpus       = EXCLUDED.cpus,
        memory_mib = EXCLUDED.memory_mib,
        labels     = EXCLUDED.labels,
        updated_at = now()
    `, [input.id, input.endpoint, input.cpus, input.memoryMiB, input.labels ?? {}]);
    return (await this.getHost(input.id))!;
  }

  /** List all hosts. Pass `healthyOnly` to get only hosts in rotation. */
  async listHosts(healthyOnly = false): Promise<SandboxHost[]> {
    const sql = healthyOnly
      ? "SELECT * FROM sandbox_hosts WHERE status = 'healthy' ORDER BY id"
      : "SELECT * FROM sandbox_hosts ORDER BY id";
    const res = await query<HostRow>(this.pool, sql);
    return res.rows.map(rowToHost);
  }

  /** Get a single host, or `undefined` if absent. */
  async getHost(id: string): Promise<SandboxHost | undefined> {
    const res = await query<HostRow>(
      this.pool,
      "SELECT * FROM sandbox_hosts WHERE id = $1",
      [id],
    );
    return res.rows[0] ? rowToHost(res.rows[0]) : undefined;
  }

  /** Mark a host unhealthy and remove it from rotation (§7.2 liveness). */
  async markUnhealthy(id: string, reason: UnhealthyReason): Promise<void> {
    await query(
      this.pool,
      "UPDATE sandbox_hosts SET status = 'unhealthy', updated_at = now() WHERE id = $1",
      [id],
    );
    void reason; // auditable reason is logged/alerted by the caller (liveness.ts).
  }

  /** Restore a host to rotation. */
  async markHealthy(id: string): Promise<void> {
    await query(
      this.pool,
      "UPDATE sandbox_hosts SET status = 'healthy', updated_at = now() WHERE id = $1",
      [id],
    );
  }

  /** Record a successful heartbeat timestamp. */
  async updateHeartbeat(id: string, at: Date = new Date()): Promise<void> {
    await query(
      this.pool,
      "UPDATE sandbox_hosts SET last_heartbeat = $1, updated_at = now() WHERE id = $2",
      [at, id],
    );
  }

  // -- placement (owner map) --------------------------------------------

  /**
   * Record that `sandboxName` runs on `hostId` (provision time, §6), storing the VM's
   * cpus/memory footprint for admission control (ROB-17). On a pure ownership reconcile
   * (boot re-attach) `resources` is omitted: a fresh row falls back to the migration
   * defaults, and an existing row keeps its recorded footprint (only the owner changes).
   */
  async recordPlacement(
    sandboxName: string,
    hostId: string,
    resources?: { cpus: number; memoryMiB: number },
  ): Promise<void> {
    const cpus = resources?.cpus ?? null;
    const memoryMiB = resources?.memoryMiB ?? null;
    await query(
      this.pool,
      `INSERT INTO sandbox_host_placements (sandbox_name, host_id, cpus, memory_mib)
       VALUES ($1, $2, COALESCE($3, 1), COALESCE($4, 512))
       ON CONFLICT (sandbox_name) DO UPDATE SET
         host_id    = EXCLUDED.host_id,
         cpus       = COALESCE($3, sandbox_host_placements.cpus),
         memory_mib = COALESCE($4, sandbox_host_placements.memory_mib)`,
      [sandboxName, hostId, cpus, memoryMiB],
    );
  }

  /** Look up the owning host for a sandbox, or `undefined`. */
  async getOwner(sandboxName: string): Promise<string | undefined> {
    const res = await query<PlacementRow>(
      this.pool,
      "SELECT host_id FROM sandbox_host_placements WHERE sandbox_name = $1",
      [sandboxName],
    );
    return res.rows[0]?.host_id;
  }

  /**
   * Per-host placement load: count + reserved cpus/memory (ROB-17). Feeds `chooseHost`'s
   * admission control so remaining capacity is computed from live placements, not just the
   * host's total capacity.
   */
  async placementUsage(): Promise<Map<string, HostLoad>> {
    const res = await query<{
      host_id: string;
      n: string;
      cpus: string;
      memory_mib: string;
    }>(
      this.pool,
      `SELECT host_id,
              COUNT(*)::text                    AS n,
              COALESCE(SUM(cpus), 0)::text       AS cpus,
              COALESCE(SUM(memory_mib), 0)::text AS memory_mib
         FROM sandbox_host_placements
        GROUP BY host_id`,
    );
    const usage = new Map<string, HostLoad>();
    for (const row of res.rows) {
      usage.set(row.host_id, {
        count: Number(row.n),
        cpus: Number(row.cpus),
        memoryMiB: Number(row.memory_mib),
      });
    }
    return usage;
  }

  /** Remove a placement row (called on destroy). */
  async removePlacement(sandboxName: string): Promise<void> {
    await query(
      this.pool,
      "DELETE FROM sandbox_host_placements WHERE sandbox_name = $1",
      [sandboxName],
    );
  }
}

/** Map a DB row to the {@link SandboxHost} domain type (camelCase). */
function rowToHost(r: HostRow): SandboxHost {
  return {
    id: r.id,
    endpoint: r.endpoint,
    cpus: r.cpus,
    memoryMiB: r.memory_mib,
    status: r.status as SandboxHost["status"],
    labels: r.labels ?? {},
    lastHeartbeat: r.last_heartbeat ? new Date(r.last_heartbeat).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}
