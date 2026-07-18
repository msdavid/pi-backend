/**
 * Contract-test harness (WP-C1.5): boots the REAL backend in-process —
 * `@testcontainers/postgresql` + `createPool`/`runMigrations`/`createApp`
 * from `@pi-managed/backend` — and listens on an ephemeral port so the
 * console API client talks to it over real HTTP with the real global
 * `fetch`. Both sides of the seam are real (CONVENTIONS.md, "Fakes at the
 * seam"); nothing here stubs a transport.
 *
 * Container-runtime detection + the fail-closed `PI_REQUIRE_INTEGRATION`
 * policy mirror `packages/backend/src/infra/db/__tests__/test-runtime.ts`
 * (that module lives under the backend's tests and is not part of its
 * public surface, so the few lines are replicated rather than imported).
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import {
  closePool,
  createApp,
  createLogger,
  createPool,
  createTenant,
  issueApiKey,
  loadConfig,
  runMigrations,
  type CreateAppOptions,
  type Pool,
} from "@pi-managed/backend";

/** Locate a container-runtime socket, setting `DOCKER_HOST` if found. */
function detectContainerRuntime(): boolean {
  if (process.env.DOCKER_HOST) return true;
  const uid =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  const podmanSocket =
    uid != null ? `/run/user/${uid}/podman/podman.sock` : undefined;
  if (podmanSocket && existsSync(podmanSocket)) {
    process.env.DOCKER_HOST = `unix://${podmanSocket}`;
    return true;
  }
  if (existsSync("/var/run/docker.sock")) {
    process.env.DOCKER_HOST = "unix:///var/run/docker.sock";
    return true;
  }
  return false;
}

/**
 * True when a container runtime is available. Fail-closed: when
 * `PI_REQUIRE_INTEGRATION` covers `containers` and none is present, this
 * throws (failing the suite) instead of allowing a silent green skip.
 */
export function requireContainers(suite: string): boolean {
  if (detectContainerRuntime()) return true;
  const raw = (process.env.PI_REQUIRE_INTEGRATION ?? "").trim().toLowerCase();
  const demanded =
    raw === "1" ||
    raw === "true" ||
    raw === "all" ||
    raw
      .split(",")
      .map((s) => s.trim())
      .includes("containers");
  if (demanded) {
    throw new Error(
      `PI_REQUIRE_INTEGRATION demands "containers" but no container runtime ` +
        `(docker or podman socket) is available on this host. Refusing to skip: ${suite}.`,
    );
  }
  process.stderr.write(
    `\n[integration-gate] SKIPPING ${suite} — no container runtime on this host. ` +
      `Set PI_REQUIRE_INTEGRATION=containers to make this a hard failure (CI).\n\n`,
  );
  return false;
}

/** A booted real backend + the fixture tenant/keys the contract tests use. */
export interface TestBackend {
  /** `http://127.0.0.1:<ephemeral-port>` — point `ConsoleApiClient.baseUrl` here. */
  baseUrl: string;
  tenantId: string;
  /** Raw API key with `admin` scope (shown once at issuance). */
  adminKey: string;
  /** Raw API key with `read` scope. */
  readKey: string;
  pool: Pool;
  /** The real Fastify app (WP-C2.1: `app.server.closeAllConnections()` lets
   * the SSE seam tests kill live connections mid-stream). */
  app: Awaited<ReturnType<typeof createApp>>;
  stop(): Promise<void>;
}

/** Options for {@link startTestBackend}. */
export interface StartTestBackendOptions {
  /**
   * Extra `CreateAppOptions` merged into the boot (WP-C2.1). The streaming
   * seam tests wire the events surface here (`resolveRuntime` +
   * `getActiveRuntime` + `sessionEvents` — without a runtime resolver the
   * Events API, `GET /v1/sessions/:id/stream` included, is not mounted) or
   * an `objectStore` so JSONL-backed entries reads have a real store.
   */
  app?: Partial<CreateAppOptions>;
  /**
   * Extra env vars merged into `loadConfig` (WP-C5.4). The billing contract
   * suite sets `BILLING_ADAPTER_URL` + `BILLING_PROVISION_TOKEN` here so the
   * backend mounts the real (SDK-free) link-out proxy pointed at a fake adapter
   * server — the console↔backend proxy is real, only the Stripe seam is faked.
   */
  configEnv?: Record<string, string>;
}

/**
 * Start Postgres (testcontainer), migrate, build the real Fastify app, and
 * listen on an ephemeral port. Also registers a root-level
 * `/v1/__test-echo-headers` diagnostic route (behind the real bearer/cookie
 * auth) that echoes the request headers back, so tests can assert what the
 * client actually put on the wire (CSRF header, Idempotency-Key) through a
 * real server-side parse.
 */
export async function startTestBackend(
  options: StartTestBackendOptions = {},
): Promise<TestBackend> {
  // Same test bootstrap as packages/backend/vitest.config.ts `env`: booting
  // the app (`getDefaultVaultCrypto()`) requires a vault key; tests opt into
  // the explicit ephemeral-key escape hatch. Set here because this package's
  // vitest config is jsdom/browser-oriented and shared with UI suites.
  process.env.ALLOW_EPHEMERAL_VAULT_KEY ??= "true";

  const container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("pitest")
    .withUsername("pitest")
    .withPassword("pitest")
    .start();
  const connectionString = container.getConnectionUri();
  const pool = createPool({ connectionString });
  await runMigrations(connectionString, "up");

  const config = loadConfig({
    env: { LOG_LEVEL: "error", ...options.configEnv },
  });
  const app = await createApp({
    config,
    logger: createLogger(config),
    pool,
    // The backend's default dist path derives from its module's
    // `import.meta.url`, which is not a file: URL under vitest's jsdom
    // environment (the UI integration suites). Pass it explicitly — vitest
    // runs with this package as cwd, so `dist/` is the built console.
    consoleDistPath: resolve(process.cwd(), "dist"),
    ...options.app,
  });
  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/v1/__test-echo-headers",
    handler: async (req) => ({ headers: req.headers }),
  });

  const tenant = await createTenant(pool, { name: "Console Contract Tenant" });
  const adminKey = (
    await issueApiKey(
      pool,
      { tenantId: tenant.id },
      { name: "console-admin", scopes: ["admin"] },
    )
  ).key;
  const readKey = (
    await issueApiKey(
      pool,
      { tenantId: tenant.id },
      { name: "console-read", scopes: ["read"] },
    )
  ).key;

  const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });

  return {
    baseUrl,
    tenantId: tenant.id,
    adminKey,
    readKey,
    pool,
    app,
    async stop() {
      await app.close();
      await closePool(pool);
      await container.stop();
    },
  };
}
