/**
 * Health & readiness endpoints (liveness + readiness probes).
 *
 * - `GET /healthz` — liveness. Always `200 {status:"ok"}` if the process is up
 *   and serving. Never depends on downstream state.
 * - `GET /readyz` — readiness. Aggregates registered {@link ReadinessCheck}s.
 *   `200 {status:"ready",checks}` when all are `up`; `503 {status:"not_ready",checks}`
 *   when any are `down`. Each check reports `{status, detail?}`.
 *
 * Checks are **pluggable**: the server factory accepts them so WP-0.2 (db pool),
 * WP-1.3 (sandbox), and P1.3 (object store) register their probes without the
 * health module depending on those subsystems. In P0.1 no checks are wired, so
 * `readyz` reports all-down (db/objectStore/sandbox) — matching the "no pool yet"
 * state.
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify";

// ---------------------------------------------------------------------------
// Readiness check contract
// ---------------------------------------------------------------------------

/** Result of a single readiness probe. */
export interface ReadinessResult {
  status: "up" | "down";
  /** Human/machine-readable reason; present especially when `down`. */
  detail?: string;
}

/**
 * A pluggable readiness probe. `name` identifies the dependency in the
 * `checks` map (e.g. `"db"`, `"objectStore"`, `"sandbox"`).
 */
export interface ReadinessCheck {
  name: string;
  /** Probe the dependency. Must not throw — return `{status:"down",detail}` on error. */
  check: () => Promise<ReadinessResult>;
}

/** Shape of each entry in the `checks` object on the readyz response. */
export interface ReadinessCheckEntry {
  status: "up" | "down";
  detail?: string;
}

// ---------------------------------------------------------------------------
// Default P0.1 checks (all down — no pool/sandbox/store wired yet)
// ---------------------------------------------------------------------------

/**
 * The P0.1 default readiness checks. Each reports `down` because its subsystem
 * has not been wired yet (no db pool, local-only object store not yet probed,
 * sandbox runtime disabled). Later WPs replace these with real probes.
 */
export const DEFAULT_READINESS_CHECKS: ReadinessCheck[] = [
  {
    name: "db",
    check: async () => ({
      status: "down",
      detail: "db pool not wired (WP-0.2)",
    }),
  },
  {
    name: "objectStore",
    check: async () => ({
      status: "down",
      detail: "object store not probed (P1.3)",
    }),
  },
  {
    name: "sandbox",
    check: async () => ({
      status: "down",
      detail: "sandbox runtime disabled (P0.1)",
    }),
  },
];

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export interface HealthPluginOptions {
  readinessChecks: ReadinessCheck[];
}

export const healthRoutes: FastifyPluginAsync<HealthPluginOptions> = async (
  app: FastifyInstance,
  opts: HealthPluginOptions,
) => {
  app.get("/healthz", async (_req, reply) => {
    return reply.status(200).send({ status: "ok" });
  });

  app.get("/readyz", async (_req, reply) => {
    const checks: Record<string, ReadinessCheckEntry> = {};
    let allUp = true;
    for (const probe of opts.readinessChecks) {
      let result: ReadinessResult;
      try {
        result = await probe.check();
      } catch (err) {
        result = {
          status: "down",
          detail: `probe threw: ${(err as Error).message}`,
        };
      }
      checks[probe.name] = { status: result.status, detail: result.detail };
      if (result.status !== "up") allUp = false;
    }
    if (allUp) {
      return reply.status(200).send({ status: "ready", checks });
    }
    return reply.status(503).send({ status: "not_ready", checks });
  });
};
