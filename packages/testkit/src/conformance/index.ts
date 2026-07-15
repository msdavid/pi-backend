/**
 * Published conformance test kits (WP-5.1, spec §29.6, §3 principle 3).
 *
 * Each `run*Conformance` function is a vitest `describe` block asserting that an
 * implementation of the matching port satisfies the contract documented on that
 * port in `@pi-managed/backend` (`domain/ports.ts`). The testkit fakes are the
 * reference behavior; the real impls and third-party plugins run the same suites.
 *
 * Import from `@pi-managed/testkit` (the kits are re-exported from the package
 * root) and call inside a `describe`:
 *
 * ```ts
 * import { describe } from "vitest";
 * import { runSandboxProviderConformance } from "@pi-managed/testkit";
 * import { MySandboxProvider } from "./my-provider.js";
 *
 * describe("MySandboxProvider conformance", () => {
 *   runSandboxProviderConformance("MySandboxProvider", async () => ({
 *     provider: new MySandboxProvider(),
 *   }));
 * });
 * ```
 */
export {
  runSandboxProviderConformance,
  type SandboxProviderFixture,
} from "./sandbox-provider.js";
export {
  runObjectStoreConformance,
  type ObjectStoreFixture,
} from "./object-store.js";
export {
  runSecretStoreConformance,
  type SecretStoreFixture,
} from "./secret-store.js";
