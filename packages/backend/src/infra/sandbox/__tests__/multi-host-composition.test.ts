/**
 * R6.7 — the composition root config-selects the multi-host sandbox provider.
 *
 * `SANDBOX_MODE=multi` must make {@link createManagedApp} build a
 * {@link MultiHostSandboxProvider} (host registry + liveness monitor + one authenticated
 * {@link HttpHostAgent} per host, §6.1) instead of the host-local `MicrosandboxProvider`,
 * with everything downstream still seeing only the `SandboxProvider` interface.
 *
 * Covers:
 *  - `SANDBOX_MODE=multi` + a two-host pool → the app's provider routes real ops to the
 *    mock hosts (reused from `mock-host.ts`) and records placements in `sandbox_hosts` /
 *    `sandbox_host_placements`.
 *  - `SANDBOX_MODE=single` (default) → the single-host provider (no routing).
 *  - A host with NO configured host-agent secret → boot **fails closed**
 *    (`HostAgentTokenMissingError`), never an unauthenticated privileged channel.
 *
 * Needs a real Postgres (the host registry is Postgres-backed); skips when no container
 * runtime is available.
 *
 * @vitest-environment node
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import pino from "pino";
import { createManagedApp, type ManagedApp } from "../../../app.js";
import type { Config } from "../../config/index.js";
import { loadConfig } from "../../config/index.js";
import { closePool, createPool, query } from "../../db/index.js";
import {
  hasContainerRuntime,
  startPostgres,
  type TestDb,
} from "../../db/__tests__/test-runtime.js";
import { MultiHostSandboxProvider } from "../multi-host-provider.js";
import { MicrosandboxProvider } from "../provider.js";
import { HostAgentTokenMissingError } from "../../sandbox-host-pool/auth.js";
import { HOST_TOKEN, MockHost } from "./mock-host.js";
import type { ProvisionSpec } from "../../../domain/ports.js";

const silentLogger = pino({ level: "silent" });
const TEST_VAULT_KEY = "0".repeat(64);

/** Mock hosts started by a test; torn down in `afterEach`. */
const started: MockHost[] = [];
async function mockHost(hostId: string): Promise<MockHost> {
  const m = new MockHost(hostId);
  await m.start();
  started.push(m);
  return m;
}

/** Config for the composed app. Env-shaped fields are set explicitly (no process.env). */
function makeConfig(dbUrl: string, over: Partial<Config>): Config {
  return {
    ...loadConfig({ env: {}, file: {} }),
    dbUrl,
    logLevel: "silent",
    sandboxRuntime: "enabled",
    ...over,
  } as Config;
}

function spec(name: string): ProvisionSpec {
  return {
    name,
    image: "ubuntu:22.04",
    cpus: 1,
    memoryMiB: 512,
    networkPolicy: { mode: "unrestricted" },
    labels: { tenant: "tnt_test", session: "sess_a" },
    detached: true,
  };
}

const d = hasContainerRuntime() ? describe : describe.skip;

d("composition root — SANDBOX_MODE (R6.7)", () => {
  let db: TestDb;
  const apps: ManagedApp[] = [];

  beforeAll(async () => {
    process.env.VAULT_KEY = TEST_VAULT_KEY;
    db = await startPostgres();
  }, 120_000);

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
    await Promise.all(started.splice(0).map((m) => m.stop()));
    // Reset the pool between cases (the host pool is infra-scoped, not tenant-scoped).
    const pool = createPool({ connectionString: db.connectionString });
    await query(pool, "DELETE FROM sandbox_host_placements");
    await query(pool, "DELETE FROM sandbox_hosts");
    await closePool(pool);
  });

  afterAll(async () => {
    await db?.container.stop();
  });

  it("SANDBOX_MODE=multi builds a MultiHostSandboxProvider routing to the host agents", async () => {
    const a = await mockHost("host_a");
    const b = await mockHost("host_b");

    const managed = await createManagedApp({
      config: makeConfig(db.connectionString, {
        sandboxMode: "multi",
        // Mock hosts speak plain HTTP; opt into the insecure transport for the test (SEC-4).
        allowInsecureHostAgent: true,
        sandboxHosts: [
          { id: "host_a", endpoint: a.endpoint, cpus: 8, memoryMiB: 16_384, labels: {} },
          { id: "host_b", endpoint: b.endpoint, cpus: 8, memoryMiB: 16_384, labels: {} },
        ],
        sandboxHostAgentToken: HOST_TOKEN,
      }),
      logger: silentLogger,
      revalidationIntervalMs: 0,
    });
    apps.push(managed);

    const provider = managed.sandboxProvider;
    expect(provider).toBeInstanceOf(MultiHostSandboxProvider);

    // The pool was upserted into the registry on boot.
    const hosts = await query<{ id: string; status: string }>(
      managed.pool,
      "SELECT id, status FROM sandbox_hosts ORDER BY id",
    );
    expect(hosts.rows.map((r) => r.id)).toEqual(["host_a", "host_b"]);

    // provision → placement recorded → the VM really exists on the chosen mock host.
    const h1 = await provider!.provision(spec("vm-1"));
    const owner = await query<{ host_id: string }>(
      managed.pool,
      "SELECT host_id FROM sandbox_host_placements WHERE sandbox_name = $1",
      ["vm-1"],
    );
    expect(owner.rows[0]?.host_id).toBeDefined();
    const ownerId = owner.rows[0]!.host_id;
    const ownerMock = ownerId === "host_a" ? a : b;
    expect(ownerMock.provider.vmCount).toBe(1);

    // Ops route to the owning host over the authenticated HTTP channel.
    const out = await provider!.exec(h1, { cmd: "echo hi" });
    expect(out.stdout).toBe("ran:echo hi");
    expect(await provider!.status(h1)).toBe("running");

    // Least-loaded placement spreads the second VM onto the other host.
    await provider!.provision(spec("vm-2"));
    expect(a.provider.vmCount).toBe(1);
    expect(b.provider.vmCount).toBe(1);

    // Pool-wide re-attach finds the VM regardless of which host owns it.
    const found = await provider!.reattachByLabels({ tenant: "tnt_test" });
    expect(found.map((h) => h.name).sort()).toEqual(["vm-1", "vm-2"]);

    // destroy drops the placement row.
    await provider!.destroy(h1);
    const after = await query(
      managed.pool,
      "SELECT 1 FROM sandbox_host_placements WHERE sandbox_name = $1",
      ["vm-1"],
    );
    expect(after.rows).toHaveLength(0);
  }, 120_000);

  it("fails closed when a host has no configured host-agent token", async () => {
    const a = await mockHost("host_a");

    await expect(
      createManagedApp({
        config: makeConfig(db.connectionString, {
          sandboxMode: "multi",
          allowInsecureHostAgent: true,
          sandboxHosts: [
            { id: "host_a", endpoint: a.endpoint, cpus: 8, memoryMiB: 16_384, labels: {} },
          ],
          // No sandboxHostAgentToken and no per-host override → no secret for host_a.
        }),
        logger: silentLogger,
        revalidationIntervalMs: 0,
      }),
    ).rejects.toBeInstanceOf(HostAgentTokenMissingError);
  }, 120_000);

  it("fails closed when a multi-host channel is not https + mTLS (SEC-4)", async () => {
    const a = await mockHost("host_a");

    // No `allowInsecureHostAgent`, no HOST_AGENT_TLS_* in the test env → the privileged
    // host-agent channel would send the pool bearer secret over cleartext http. Boot must
    // refuse rather than degrade to plain fetch.
    await expect(
      createManagedApp({
        config: makeConfig(db.connectionString, {
          sandboxMode: "multi",
          sandboxHosts: [
            { id: "host_a", endpoint: a.endpoint, cpus: 8, memoryMiB: 16_384, labels: {} },
          ],
          sandboxHostAgentToken: HOST_TOKEN,
        }),
        logger: silentLogger,
        revalidationIntervalMs: 0,
      }),
    ).rejects.toThrow(/mutual-TLS|https/);
  }, 120_000);

  it("SANDBOX_MODE=single (default) keeps the host-local provider", async () => {
    const managed = await createManagedApp({
      config: makeConfig(db.connectionString, {}),
      logger: silentLogger,
      revalidationIntervalMs: 0,
    });
    apps.push(managed);
    expect(managed.sandboxProvider).toBeInstanceOf(MicrosandboxProvider);
    expect(managed.sandboxProvider).not.toBeInstanceOf(MultiHostSandboxProvider);
  }, 120_000);
});
