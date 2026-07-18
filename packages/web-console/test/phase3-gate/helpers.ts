/**
 * Shared helpers for the phase-3 conformance gate (console-spec §13).
 *
 * `HealthCapableFake` extends the collaborator fake with the
 * `HealthProber` capability `src/api/health.ts` duck-types for, so gate
 * renders of /settings/health never fall back to the real `fetch` prober —
 * and every probe is recorded in `calls` (method "PROBE"), which is how the
 * mode-matrix gate proves saas mode fires ZERO probes.
 */
import type {
  HealthPath,
  HealthProbeResponse,
  HealthProber,
} from "../../src/api/health.js";
import { FakeConsoleApi } from "../../src/test/fake-console-api.js";

/** All-up probe answers; every probe lands in `calls` as method "PROBE". */
export class HealthCapableFake extends FakeConsoleApi implements HealthProber {
  async probeHealth(path: HealthPath): Promise<HealthProbeResponse> {
    this.calls.push({ method: "PROBE", path });
    return path === "/healthz"
      ? { status: 200, body: { status: "ok" } }
      : {
          status: 200,
          body: {
            status: "ready",
            checks: { db: { status: "up" }, objectStore: { status: "up" } },
          },
        };
  }
}
