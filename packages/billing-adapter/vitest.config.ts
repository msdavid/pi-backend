import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Integration tests boot a Postgres testcontainer + a listening Fastify app.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // The backend refuses to boot with an ephemeral vault key unless opted in
    // (mirrors packages/backend/vitest.config.ts). The crypto reads process.env
    // directly, so it must be set here. Test-only — no real key ships.
    env: {
      ALLOW_EPHEMERAL_VAULT_KEY: "true",
    },
  },
});
