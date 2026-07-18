/**
 * Real-backend harness for the adapter's integration tests (CONVENTIONS: fakes at
 * the seam — where the adapter↔backend boundary IS the subject, both sides are
 * real). Boots a Postgres testcontainer + a LISTENING in-process Fastify app so
 * the adapter's {@link HttpLedgerClient} drives the genuine machine credit-surface
 * over real HTTP (no stubbed transport).
 *
 * The machine token below is a locally-generated, obviously test-only string — NOT
 * a provider credential (CONVENTIONS: never place provider credentials anywhere).
 */

import { existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import pino from "pino";
import {
  createApp,
  createPool,
  closePool,
  runMigrations,
  loadConfig,
  createTenant,
  issueApiKey,
  query,
  type Pool,
} from "@pi-managed/backend";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

/** Obviously test-only machine secret for `POST /internal/billing/credit`. */
export const TEST_MACHINE_TOKEN = "test-only-billing-provision-secret-not-a-real-credential";

export interface BackendHarness {
  /** Base URL of the listening app (e.g. `http://127.0.0.1:34567`). */
  baseUrl: string;
  provisionToken: string;
  pool: Pool;
  freshTenant(): Promise<string>;
  /** Issue a tenant API key (raw secret) with the given scopes — for the `/v1` proxy tests. */
  issueTenantKey(tenantId: string, scopes: string[]): Promise<string>;
  /** Count `topup` ledger entries for a tenant (money-invariant assertion). */
  countTopups(tenantId: string): Promise<number>;
  balanceMicros(tenantId: string): Promise<number>;
  close(): Promise<void>;
}

/** Options for {@link startBackendHarness}. */
export interface BackendHarnessOptions {
  /**
   * Base URL of a running billing-adapter internal surface. When set, the backend's
   * link-out proxy (`/v1/tenant/billing/{checkout,portal,auto-charge}`) forwards to
   * it (WP-C5.3 F4). Unset ⇒ those routes return the no-adapter `404` (§11.8).
   */
  adapterBaseUrl?: string;
}

/** True when a container runtime (docker/podman) is reachable. */
function hasContainerRuntime(): boolean {
  if (process.env.DOCKER_HOST) return true;
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const socket = uid != null ? `/run/user/${uid}/podman/podman.sock` : undefined;
  if (socket && existsSync(socket)) {
    process.env.DOCKER_HOST = `unix://${socket}`;
    return true;
  }
  if (existsSync("/var/run/docker.sock")) {
    process.env.DOCKER_HOST = "unix:///var/run/docker.sock";
    return true;
  }
  return false;
}

/**
 * Whether the integration suites can run here. Fail-closed when
 * `PI_REQUIRE_INTEGRATION` demands containers (CI); a loud skip otherwise (local).
 */
export function integrationAvailable(suite: string): boolean {
  if (hasContainerRuntime()) return true;
  const raw = (process.env.PI_REQUIRE_INTEGRATION ?? "").trim().toLowerCase();
  const demanded =
    raw === "1" || raw === "true" || raw === "all" || raw.split(",").map((s) => s.trim()).includes("containers");
  if (demanded) {
    throw new Error(
      `PI_REQUIRE_INTEGRATION demands "containers" but no container runtime is available. ` +
        `Refusing to skip: ${suite}.`,
    );
  }
  process.stderr.write(`\n[integration-gate] SKIPPING ${suite} — no container runtime.\n\n`);
  return false;
}

/** Start Postgres + a listening app with billing enabled and the machine token set. */
export async function startBackendHarness(
  options: BackendHarnessOptions = {},
): Promise<BackendHarness> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("pitest")
    .withUsername("pitest")
    .withPassword("pitest")
    .start();
  const connectionString = container.getConnectionUri();
  const pool = createPool({ connectionString });
  await runMigrations(connectionString, "up");

  const app: FastifyInstance = await createApp({
    config: loadConfig({
      env: {
        BILLING_PROVISION_TOKEN: TEST_MACHINE_TOKEN,
        BILLING_ENABLED: "true",
        LOG_LEVEL: "error",
        ...(options.adapterBaseUrl ? { BILLING_ADAPTER_URL: options.adapterBaseUrl } : {}),
      },
    }),
    logger: pino({ level: "error" }),
    pool,
  });
  const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });

  return {
    baseUrl,
    provisionToken: TEST_MACHINE_TOKEN,
    pool,
    async freshTenant() {
      const t = await createTenant(pool, { name: `Billing ${Math.random()}` });
      return t.id;
    },
    async issueTenantKey(tenantId: string, scopes: string[]) {
      const issued = await issueApiKey(pool, { tenantId }, { name: `test-${Math.random()}`, scopes });
      return issued.key;
    },
    async countTopups(tenantId: string) {
      const { rows } = await query<{ n: string }>(
        pool,
        `SELECT count(*)::text AS n FROM ledger_entries WHERE tenant_id = $1 AND kind = 'topup'`,
        [tenantId],
      );
      return Number(rows[0].n);
    },
    async balanceMicros(tenantId: string) {
      const { rows } = await query<{ balance_micros: string }>(
        pool,
        `SELECT balance_micros FROM tenant_billing WHERE tenant_id = $1`,
        [tenantId],
      );
      return rows[0] ? Number(rows[0].balance_micros) : 0;
    },
    async close() {
      await app.close();
      await closePool(pool);
      await container.stop();
    },
  };
}
