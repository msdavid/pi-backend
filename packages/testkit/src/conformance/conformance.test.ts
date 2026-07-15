/**
 * Reference run of the published conformance kits against the testkit fakes.
 *
 * The fakes ARE the reference behavior — these suites prove the kits themselves
 * pass against the reference, so any divergence a third-party impl reports is a
 * real contract violation, not a kit bug.
 */

import { describe } from "vitest";
import {
  FakeObjectStore,
  FakeSandboxProvider,
  FakeSecretStore,
  runObjectStoreConformance,
  runSandboxProviderConformance,
  runSecretStoreConformance,
} from "../index.js";

describe("conformance kits — reference run against fakes", () => {
  runSandboxProviderConformance("FakeSandboxProvider", async () => {
    const provider = new FakeSandboxProvider();
    return {
      provider,
      seed: (name) =>
        provider.scriptExec(name, [
          {
            stdout: "hello\n",
            chunks: [{ stream: "stdout", data: "hello\n" }],
          },
        ]),
    };
  });

  runObjectStoreConformance("FakeObjectStore", async () => ({
    store: new FakeObjectStore(),
  }));

  runSecretStoreConformance("FakeSecretStore", async () => {
    const store = new FakeSecretStore();
    return {
      store,
      seed: async (ctx, bindings) => {
        store.scriptForSession(ctx.sessionId, bindings);
      },
    };
  });
});
