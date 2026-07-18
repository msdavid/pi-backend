import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      // The Vite + React console. jsdom + Testing Library; jest-dom matchers
      // registered in the setup file.
      {
        test: {
          name: "console",
          environment: "jsdom",
          include: ["src/**/*.test.{ts,tsx}"],
          setupFiles: ["./src/test/setup.ts"],
        },
      },
      // Conformance gates (console-spec §13; `pnpm test:gate` runs them
      // alone, mirroring the backend's test/phase1-gate/ pattern; extended
      // per phase, never trimmed). ONE project for all phase dirs: several
      // gate files rebuild dist/ and others read/serve it, so every gate
      // file must share the same single sequential worker — two projects
      // would interleave their builds. jsdom by default for the UI-level
      // items; real-backend and static-scan files opt into node with a
      // per-file `// @vitest-environment node`.
      {
        test: {
          name: "conformance-gate",
          environment: "jsdom",
          include: [
            "test/phase1-gate/**/*.test.{ts,tsx}",
            "test/phase2-gate/**/*.test.{ts,tsx}",
            "test/phase3-gate/**/*.test.{ts,tsx}",
            "test/phase4-gate/**/*.test.{ts,tsx}",
            "test/phase5-gate/**/*.test.{ts,tsx}",
          ],
          setupFiles: ["./src/test/setup.ts"],
          // Container boots + `vite build` runs exceed the 10s defaults.
          hookTimeout: 180_000,
          testTimeout: 180_000,
          // The §12.1 items rebuild dist/ and the §3.4 items read/serve it —
          // gate files must not interleave.
          fileParallelism: false,
        },
      },
    ],
  },
});
