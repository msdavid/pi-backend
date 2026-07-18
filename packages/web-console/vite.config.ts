import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Backend origin the dev server proxies API traffic to. The console is
 * same-origin with `/v1` in production (served by the backend at `/console`,
 * see `packages/backend/src/api/console.ts`); in dev, Vite serves the app and
 * forwards the backend-owned paths so cookies stay same-origin. 3000 is the
 * backend's default `PORT` (`packages/backend/src/infra/config/index.ts`).
 */
const BACKEND_ORIGIN = "http://localhost:3000";

export default defineConfig({
  // Served under this prefix by the backend serve hook — all asset URLs must
  // resolve as /console/... (console-spec §3.1).
  base: "/console/",
  plugins: [react()],
  server: {
    proxy: {
      // Public API. `/console/config` and `/console/session` are the
      // console-support endpoints (console-spec §3–§4); every other
      // /console/* path is the SPA itself and stays with Vite. The two
      // public health probes feed the solo/team Settings widget (C§5.1,
      // src/api/health.ts) and are backend-owned too.
      "/v1": BACKEND_ORIGIN,
      "/console/config": BACKEND_ORIGIN,
      "/console/session": BACKEND_ORIGIN,
      "/healthz": BACKEND_ORIGIN,
      "/readyz": BACKEND_ORIGIN,
    },
  },
});
