/**
 * DB readiness probe (WP-P0.2). A {@link ReadinessCheck} that runs `SELECT 1`
 * against a `pg.Pool`; reports `up` on success or `down` with the error message.
 *
 * Wired into `createApp` (server.ts) so `/readyz` reflects real DB
 * reachability instead of the P0.1 "db pool not wired" stub.
 */

import { type Pool } from "pg";
import { type ReadinessCheck } from "../../api/health.js";

/** Build a `/readyz` probe named `"db"` backed by `pool`. */
export function dbReadinessCheck(pool: Pool): ReadinessCheck {
  return {
    name: "db",
    check: async () => {
      try {
        await pool.query("SELECT 1");
        return { status: "up" };
      } catch (err) {
        return { status: "down", detail: (err as Error).message };
      }
    },
  };
}
