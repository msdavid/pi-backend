/**
 * The single `@kvm` availability gate (R1.2).
 *
 * Every `@kvm`-tagged suite used to carry its own copy of
 * `existsSync("/dev/kvm") && isInstalled()`, which meant a host without KVM
 * silently skipped 100% of the microVM / host-escape / credential-injection /
 * e2e coverage — including in CI. This module is now the only definition, and it
 * routes through {@link requireCapability}: a missing runtime is a **hard error**
 * when `PI_REQUIRE_INTEGRATION` demands `kvm`, and a loud skip banner otherwise.
 *
 * Usage (module scope, so the throw fails the file):
 *
 * ```ts
 * const KVM = kvmRuntimeAvailable("@kvm MicrosandboxProvider");
 * describe.skipIf(!KVM)("@kvm MicrosandboxProvider", () => { … });
 * ```
 */

import { existsSync } from "node:fs";
import { isInstalled } from "microsandbox";
import { requireCapability } from "../../db/__tests__/test-runtime.js";

/** Raw probe: a usable microsandbox runtime needs `/dev/kvm` AND the msb install. */
export function kvmRuntimeDetected(): boolean {
  return existsSync("/dev/kvm") && isInstalled();
}

/**
 * `true` when a real microsandbox runtime is usable (KVM + installed).
 *
 * @param suite name of the suite that needs it — quoted in the skip banner and in
 *              the hard error raised under `PI_REQUIRE_INTEGRATION`
 * @throws when KVM/msb is missing and `PI_REQUIRE_INTEGRATION` covers `kvm`
 */
export function kvmRuntimeAvailable(suite = "@kvm suite"): boolean {
  return requireCapability("kvm", suite, kvmRuntimeDetected());
}
