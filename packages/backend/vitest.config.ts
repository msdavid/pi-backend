import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // Many suites boot a real testcontainers Postgres in `beforeAll`. Under full-suite
    // parallel load that start can exceed vitest's 10s default hook timeout, so every
    // container-starting suite gets a generous default here rather than relying on each
    // suite to remember its own per-hook timeout.
    hookTimeout: 180_000,
    // Test bootstrap: `resolveVaultKeySource` no longer treats `NODE_ENV=test` as
    // an implicit ephemeral-key opt-in (WP-R0.7), so booting the app in tests
    // (e.g. `getDefaultVaultCrypto()`) now needs the explicit escape hatch.
    env: {
      ALLOW_EPHEMERAL_VAULT_KEY: "true",
    },
  },
});
