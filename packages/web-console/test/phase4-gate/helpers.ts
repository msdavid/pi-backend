/**
 * Shared helpers for the phase-4 conformance gate (console-spec §13,
 * WP-C4.3).
 *
 * The one thing phase 4 needs beyond the phase-1 helpers is the `@kvm`
 * availability gate for the continue-anywhere flow test: a REAL cold wake
 * provisions a microVM, which needs `/dev/kvm` plus an installed
 * microsandbox runtime. The backend's canonical probe
 * (`packages/backend/src/infra/sandbox/__tests__/kvm-gate.ts`) is test-only
 * (not exported) and `microsandbox` is not a dependency of this package —
 * so the SAME probe (`isInstalled()` from the msb SDK) runs as a child
 * process from the backend package, where the import resolves. No drift, no
 * new dependency.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { pkgRoot } from "../phase1-gate/helpers.js";

/** The backend workspace package — where `microsandbox` resolves. */
const backendRoot = resolve(pkgRoot, "../backend");

/** Raw probe: `/dev/kvm` present AND the msb runtime installed. */
export function kvmRuntimeDetected(): boolean {
  if (!existsSync("/dev/kvm")) return false;
  try {
    execSync(
      `node --input-type=module -e "const m = await import('microsandbox'); process.exit(m.isInstalled() ? 0 : 1)"`,
      { cwd: backendRoot, stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * `true` when a real microsandbox runtime is usable. Fail-closed like the
 * backend's `kvm-gate.ts`: when `PI_REQUIRE_INTEGRATION` covers `kvm`, a
 * missing runtime throws (failing the suite) instead of skipping green;
 * otherwise a loud skip banner is printed. `PI_REQUIRE_INTEGRATION=containers`
 * (the repo's CI setting) deliberately does NOT demand kvm — non-KVM hosts
 * skip this suite cleanly.
 */
export function kvmRuntimeAvailable(suite: string): boolean {
  if (kvmRuntimeDetected()) return true;
  const raw = (process.env.PI_REQUIRE_INTEGRATION ?? "").trim().toLowerCase();
  const demanded =
    raw === "1" ||
    raw === "true" ||
    raw === "all" ||
    raw
      .split(",")
      .map((s) => s.trim())
      .includes("kvm");
  if (demanded) {
    throw new Error(
      `PI_REQUIRE_INTEGRATION demands "kvm" but /dev/kvm or the microsandbox ` +
        `runtime is missing on this host. Refusing to skip: ${suite}.`,
    );
  }
  process.stderr.write(
    `\n[integration-gate] SKIPPING ${suite} — no KVM/microsandbox runtime on ` +
      `this host. Set PI_REQUIRE_INTEGRATION=kvm to make this a hard failure.\n\n`,
  );
  return false;
}
