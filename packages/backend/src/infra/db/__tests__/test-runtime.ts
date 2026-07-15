/**
 * Test bootstrap: a real Postgres via `@testcontainers/postgresql`, plus the
 * **integration-gate policy** shared by every capability-gated suite (R1.2).
 *
 * testcontainers needs a container runtime socket. It reads `DOCKER_HOST`;
 * when unset we auto-detect a podman user socket (`/run/user/<uid>/podman/
 * podman.sock`) so the suite runs in dev environments without a docker daemon.
 *
 * ## Fail-closed: `PI_REQUIRE_INTEGRATION`
 *
 * By default (env unset — the local-dev case) a missing capability makes the
 * dependent suites **skip**, with a loud banner on stderr, so `pnpm test` stays
 * green on a laptop without podman/KVM.
 *
 * In CI that is unacceptable: a silently-skipped security suite is a green build
 * that proved nothing. Set `PI_REQUIRE_INTEGRATION` and a missing capability
 * becomes a **hard error** naming the suites that could not run:
 *
 * | Value                 | Requires                                    |
 * |-----------------------|---------------------------------------------|
 * | `1` / `true` / `all`  | container runtime **and** `/dev/kvm` + msb  |
 * | `containers`          | container runtime only                      |
 * | `kvm`                 | `/dev/kvm` + msb runtime only               |
 * | `containers,kvm`      | both (same as `1`)                          |
 * | unset / `0` / `false` | nothing — auto-detect + loud skip banner     |
 *
 * The scoped values exist because the two capabilities live on different CI
 * runners: the GitHub-hosted `test` job has docker but no `/dev/kvm` (so it sets
 * `containers`), while the self-hosted `kvm` job has both (and sets `1`).
 *
 * The `@kvm` half of the policy lives in `../../sandbox/__tests__/kvm-gate.ts`,
 * which reuses {@link requireCapability} from here.
 */

import { existsSync } from "node:fs";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";

/** A started test Postgres + its connection string. */
export interface TestDb {
  container: StartedPostgreSqlContainer;
  connectionString: string;
}

/** The host capabilities a suite can demand. */
export type IntegrationCapability = "containers" | "kvm";

/**
 * True when `PI_REQUIRE_INTEGRATION` demands `capability` — i.e. its absence must
 * fail the run rather than skip it.
 */
export function requiresIntegration(capability: IntegrationCapability): boolean {
  const raw = (process.env.PI_REQUIRE_INTEGRATION ?? "").trim().toLowerCase();
  if (raw === "" || raw === "0" || raw === "false") return false;
  if (raw === "1" || raw === "true" || raw === "all") return true;
  return raw
    .split(",")
    .map((s) => s.trim())
    .includes(capability);
}

/**
 * Enforce the fail-closed policy for one capability.
 *
 * @param capability the host capability the suite needs
 * @param suite      name of the suite(s) that cannot run without it
 * @param available  whether the capability was detected on this host
 * @returns `available` unchanged — so callers can `describe.skipIf(!…)`
 * @throws when the capability is missing AND `PI_REQUIRE_INTEGRATION` demands it
 */
export function requireCapability(
  capability: IntegrationCapability,
  suite: string,
  available: boolean,
): boolean {
  if (available) return true;
  const what =
    capability === "kvm"
      ? "/dev/kvm + an installed microsandbox runtime"
      : "a container runtime (docker or podman socket)";
  if (requiresIntegration(capability)) {
    throw new Error(
      `PI_REQUIRE_INTEGRATION demands "${capability}" but ${what} is not available ` +
        `on this host. Refusing to skip: ${suite}. Run on a capable runner, or unset ` +
        `PI_REQUIRE_INTEGRATION to allow skipping (local dev only).`,
    );
  }
  warnSkip(`SKIPPING ${suite} — this host has no ${what}.`);
  return false;
}

/** Banners already emitted in this worker (vitest isolates files; dedupe per-process). */
const warned = new Set<string>();

/** Loud skip banner on stderr — a skipped suite is never silent (R1.2). */
function warnSkip(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  const bar = "=".repeat(78);
  process.stderr.write(
    `\n${bar}\n[integration-gate] ${message}\n` +
      `[integration-gate] Set PI_REQUIRE_INTEGRATION=1 to make this a hard failure (CI).\n${bar}\n\n`,
  );
}

/** Cached probe — a runtime socket does not appear mid-run. */
let containerRuntime: boolean | undefined;

/**
 * Locate a container-runtime socket, setting `DOCKER_HOST` if one is found.
 * Returns true when a runtime is available (docker or podman).
 *
 * Detection only — no policy. Suites should call {@link hasContainerRuntime}.
 */
export function ensureContainerRuntime(): boolean {
  containerRuntime ??= detectContainerRuntime();
  return containerRuntime;
}

function detectContainerRuntime(): boolean {
  if (process.env.DOCKER_HOST) return true;
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const podmanSocket =
    uid != null ? `/run/user/${uid}/podman/podman.sock` : undefined;
  if (podmanSocket && existsSync(podmanSocket)) {
    process.env.DOCKER_HOST = `unix://${podmanSocket}`;
    return true;
  }
  // Rootful docker (GitHub-hosted runners) / rootful podman.
  if (existsSync("/var/run/docker.sock")) {
    process.env.DOCKER_HOST = "unix:///var/run/docker.sock";
    return true;
  }
  return false;
}

/**
 * `true` when a container runtime is available.
 *
 * Fail-closed: when `PI_REQUIRE_INTEGRATION` covers `containers` and no runtime is
 * present this **throws** (failing the calling suite) instead of returning `false`;
 * otherwise it prints a loud skip banner and returns `false`.
 *
 * @param suite optional suite name used in the error/banner
 */
export function hasContainerRuntime(suite = "Postgres integration suite"): boolean {
  return requireCapability("containers", suite, ensureContainerRuntime());
}

/**
 * Start a fresh Postgres 16 container. Caller MUST stop it (`.stop()`) in
 * `afterAll`/`afterEach` — typically via the returned `container`.
 */
export async function startPostgres(): Promise<TestDb> {
  ensureContainerRuntime();
  const container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("pitest")
    .withUsername("pitest")
    .withPassword("pitest")
    .start();
  // Reuse the runtime connection URI (includes host/port/credentials).
  const connectionString = container.getConnectionUri();
  return { container, connectionString };
}
