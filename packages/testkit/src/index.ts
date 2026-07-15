/**
 * @pi-managed/testkit — shared test fixtures (plan §3.1).
 *
 * Fakes for every internal seam port (WP-0.10). Each fake implements the corresponding
 * port from `@pi-managed/backend` with happy-path behavior plus hooks for test scenarios.
 * See `docs/internal-contracts.md`.
 */

/** Package version (placeholder until real fixtures land). */
export const TESTKIT_VERSION = "0.0.0";

export { FakeSandboxProvider } from "./fake-sandbox-provider.js";
export type { ExecScriptEntry, FakeSandboxCall } from "./fake-sandbox-provider.js";

export { FakeSessionRuntime } from "./fake-session-runtime.js";
export { FakeSecretStore } from "./fake-secret-store.js";
export { FakeObjectStore } from "./fake-object-store.js";
export {
  FakeUsageRecorder,
  type PriceEntry,
} from "./fake-usage-recorder.js";
export { FakeClock, FakeScheduler } from "./fake-clock.js";
export { FakeWebhookSink } from "./fake-webhook-sink.js";

// WP-5.1 published conformance test kits (one per port).
export {
  runSandboxProviderConformance,
  runObjectStoreConformance,
  runSecretStoreConformance,
  type SandboxProviderFixture,
  type ObjectStoreFixture,
  type SecretStoreFixture,
} from "./conformance/index.js";

import { FakeClock } from "./fake-clock.js";
import { FakeObjectStore } from "./fake-object-store.js";
import { FakeSandboxProvider } from "./fake-sandbox-provider.js";
import { FakeScheduler } from "./fake-clock.js";
import { FakeSecretStore } from "./fake-secret-store.js";
import { FakeSessionRuntime } from "./fake-session-runtime.js";
import { FakeUsageRecorder } from "./fake-usage-recorder.js";
import { FakeWebhookSink } from "./fake-webhook-sink.js";

/**
 * A bundle of wired-together fakes. Each is independent (no shared state); consumers
 * wire them into the subsystem under test. The factory gives a single call site so tests
 * stay short and the wiring stays consistent.
 */
export interface TestKit {
  sandbox: FakeSandboxProvider;
  session: FakeSessionRuntime;
  secrets: FakeSecretStore;
  objects: FakeObjectStore;
  usage: FakeUsageRecorder;
  clock: FakeClock;
  scheduler: FakeScheduler;
  webhooks: FakeWebhookSink;
}

/** Create a fresh bundle of wired-together fakes. */
export function createTestKit(): TestKit {
  return {
    sandbox: new FakeSandboxProvider(),
    session: new FakeSessionRuntime(),
    secrets: new FakeSecretStore(),
    objects: new FakeObjectStore(),
    usage: new FakeUsageRecorder(),
    clock: new FakeClock(),
    scheduler: new FakeScheduler(),
    webhooks: new FakeWebhookSink(),
  };
}
