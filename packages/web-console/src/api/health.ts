/**
 * Public health endpoints — `GET /healthz` + `GET /readyz` (WP-C3.6).
 *
 * Console-spec §5.1: the solo/team Settings surface includes a backend health
 * widget reading the PUBLIC probes (decision 4, console.md §10.4: the widget
 * does not render in saas mode — the feature page enforces that; this module
 * is mode-agnostic plumbing). These are the only two endpoints the console
 * touches outside `/v1` + the §3–§4 console-support pair, and they are pinned
 * as such by the phase-1 endpoint-allowlist gate
 * (`test/phase1-gate/api-surface.gate.test.ts`).
 *
 * Why not `ConsoleApiClient`: `/readyz` answers `503 {status:"not_ready",
 * checks}` when any dependency is down — a NON-2xx response whose body is the
 * widget's whole point (per-component readiness), while the JSON client turns
 * every non-2xx into a thrown error and discards the body (it is not the
 * error envelope). So this module carries its own tiny probe transport over
 * the real global `fetch` (a sanctioned transport in the phase-1 gate) that
 * treats 200 and 503 as equally readable snapshots.
 *
 * Testability mirrors `session-stream.ts`'s {@link SessionStreamer} pattern:
 * the hooks duck-type the injected {@link ConsoleApi} for an optional
 * {@link HealthProber} capability, so UI tests script probes on their fake
 * without stubbing `fetch`; the fetch prober itself is contract-tested
 * against the real backend (`__tests__/tenant-files-skills.contract.test.ts`).
 *
 * Query keys are local: `src/api/keys.ts` factories cover the `/v1` families;
 * the non-`/v1` health probes keep theirs here (same shape).
 */

import { useQuery } from "@tanstack/react-query";

import { ConsoleApiError, type ConsoleApi } from "./client.js";
import { useApiClient } from "./provider.js";

/** The complete allowed probe surface (console-spec §5.1). */
export type HealthPath = "/healthz" | "/readyz";

/** Raw probe outcome: HTTP status + parsed JSON body (`undefined` if none). */
export interface HealthProbeResponse {
  status: number;
  body: unknown;
}

/**
 * The probe capability the hooks duck-type for on the injected client
 * (fakes implement it; production falls back to {@link fetchHealthProber}).
 */
export interface HealthProber {
  probeHealth(path: HealthPath): Promise<HealthProbeResponse>;
}

/** Build a fetch-backed prober; `baseUrl` is for contract tests (same-origin
 * relative in the browser, like `ConsoleApiClient`). */
export function createHealthProber(baseUrl = ""): HealthProber {
  return {
    async probeHealth(path: HealthPath): Promise<HealthProbeResponse> {
      let res: Response;
      try {
        res = await fetch(`${baseUrl}${path}`, {
          headers: { Accept: "application/json" },
          credentials: "same-origin",
        });
      } catch (cause) {
        throw new ConsoleApiError(`request failed: GET ${path}`, { cause });
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = undefined; // non-JSON body (a proxy error page) — status decides
      }
      return { status: res.status, body };
    },
  };
}

/** The app-wide prober (same-origin — the backend serves the console). */
export const fetchHealthProber: HealthProber = createHealthProber();

/** The prober for an injected client: its own capability when it has one. */
function proberFor(api: ConsoleApi): HealthProber {
  const capability = (api as Partial<HealthProber>).probeHealth;
  return capability
    ? { probeHealth: capability.bind(api) }
    : fetchHealthProber;
}

// --- Parsed snapshots --------------------------------------------------------

/** `GET /healthz` — liveness. `200 {status:"ok"}` iff the process serves. */
export interface HealthzSnapshot {
  status: "ok";
}

/** One `/readyz` dependency check (backend `api/health.ts` `checks` entry). */
export interface ReadyzCheck {
  name: string;
  status: "up" | "down";
  detail?: string;
}

/** `GET /readyz` — readiness. `200 ready` / `503 not_ready`, same body. */
export interface ReadyzSnapshot {
  ready: boolean;
  checks: ReadyzCheck[];
}

// --- Fetchers ---------------------------------------------------------------

/** `GET /healthz` — throws on anything but the documented `200 {status:"ok"}`. */
export async function getHealthz(
  prober: HealthProber = fetchHealthProber,
): Promise<HealthzSnapshot> {
  const res = await prober.probeHealth("/healthz");
  const body = res.body as { status?: unknown } | undefined;
  if (res.status !== 200 || body?.status !== "ok") {
    throw new ConsoleApiError(`GET /healthz failed: ${res.status}`, {
      status: res.status,
    });
  }
  return { status: "ok" };
}

/**
 * `GET /readyz` — parses BOTH documented outcomes (`200 {status:"ready"}` and
 * `503 {status:"not_ready"}`) into one snapshot; anything else throws.
 */
export async function getReadyz(
  prober: HealthProber = fetchHealthProber,
): Promise<ReadyzSnapshot> {
  const res = await prober.probeHealth("/readyz");
  const body = res.body as
    | { status?: unknown; checks?: Record<string, unknown> }
    | undefined;
  const wellFormed =
    (res.status === 200 && body?.status === "ready") ||
    (res.status === 503 && body?.status === "not_ready");
  if (!wellFormed) {
    throw new ConsoleApiError(`GET /readyz failed: ${res.status}`, {
      status: res.status,
    });
  }
  const checks = Object.entries(body?.checks ?? {}).map(
    ([name, entry]): ReadyzCheck => {
      const check = entry as { status?: unknown; detail?: unknown };
      return {
        name,
        status: check.status === "up" ? "up" : "down",
        detail: typeof check.detail === "string" ? check.detail : undefined,
      };
    },
  );
  return { ready: body?.status === "ready", checks };
}

// --- Query hooks -------------------------------------------------------------

/** Local key factory (non-`/v1` family — see module header). */
export const healthKeys = {
  all: ["health"] as const,
  healthz: () => [...healthKeys.all, "healthz"] as const,
  readyz: () => [...healthKeys.all, "readyz"] as const,
};

/** Liveness (C§5.1). Mount only on the solo/team health page. */
export function useHealthz() {
  const api = useApiClient();
  return useQuery({
    queryKey: healthKeys.healthz(),
    queryFn: () => getHealthz(proberFor(api)),
  });
}

/** Readiness incl. per-dependency checks (C§5.1). */
export function useReadyz() {
  const api = useApiClient();
  return useQuery({
    queryKey: healthKeys.readyz(),
    queryFn: () => getReadyz(proberFor(api)),
  });
}
