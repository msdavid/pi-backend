/**
 * `/v1/environments` family of the {@link FakeConsoleApi} (WP-C3-prep).
 * Basic CRUD in-memory plus the self-hosted surface: `work-stats` (seed via
 * `workStats`), worker-key mint (raw key in the response only — an obviously
 * fake value, never a real-looking credential), and `work-stop`.
 */
import type { Environment, WorkStats } from "@pi-managed/contracts";

import { notFound, pageOf } from "./wire.js";

/** A full wire-shaped environment (contracts `Environment`). */
export function makeEnvironment(
  overrides: Partial<Environment> & { id: string },
): Environment {
  return {
    name: "python-env",
    type: "cloud",
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

const EMPTY_STATS: WorkStats = {
  depth: 0,
  pending: 0,
  oldestQueuedAt: null,
  workersPolling: 0,
};

/** The slice of `FakeConsoleApi` state the environments family uses. */
export interface EnvironmentsState {
  environments: Environment[];
  workStats: Map<string, WorkStats>;
}

function findEnvironment(state: EnvironmentsState, id: string): Environment {
  const found = state.environments.find((e) => e.id === id);
  if (!found) throw notFound(id);
  return found;
}

/** `GET /v1/environments*` — the wire body, or `undefined` if unmatched. */
export function environmentsGet(
  state: EnvironmentsState,
  pathname: string,
  params: URLSearchParams,
): unknown | undefined {
  if (pathname === "/v1/environments") {
    const status = params.get("status");
    const matches = state.environments.filter(
      (e) => !status || e.status === status,
    );
    return pageOf(matches, params);
  }
  const match = pathname.match(/^\/v1\/environments\/([^/]+)(?:\/(work-stats))?$/);
  if (!match) return undefined;
  const env = findEnvironment(state, decodeURIComponent(match[1]!));
  if (match[2] === "work-stats") {
    return state.workStats.get(env.id) ?? EMPTY_STATS;
  }
  return env;
}

/** `POST /v1/environments*` — create / archive / worker-keys / work-stop. */
export function environmentsPost(
  state: EnvironmentsState,
  pathname: string,
  body: unknown,
): unknown | undefined {
  if (pathname === "/v1/environments") {
    const create = body as Partial<Environment> & { name: string };
    const env = makeEnvironment({
      id: `env_01TESTNEW${state.environments.length + 1}`,
      name: create.name,
      ...(create.type ? { type: create.type } : {}),
    });
    state.environments.push(env);
    return env;
  }
  const action = pathname.match(
    /^\/v1\/environments\/([^/]+)\/(archive|worker-keys|work-stop)$/,
  );
  if (!action) return undefined;
  const env = findEnvironment(state, decodeURIComponent(action[1]!));
  if (action[2] === "archive") {
    env.status = "archived";
    return env;
  }
  if (action[2] === "worker-keys") {
    const { name } = body as { name: string };
    return {
      id: "apikey_01TESTWORKER",
      name,
      key: "pmb_live_TESTWORKERKEYNOTASECRET",
      environmentId: env.id,
      createdAt: "2026-07-15T12:00:00.000Z",
    };
  }
  // work-stop: echo a stopped work item for the addressed session.
  const { sessionId, force } = body as { sessionId: string; force?: boolean };
  return {
    id: "wrk_01TESTWORK",
    sessionId,
    status: "stopped",
    stopRequested: force ? "force" : "clean",
  };
}

/** `PATCH /v1/environments/:id` — merge update; `undefined` if unmatched. */
export function environmentsPatch(
  state: EnvironmentsState,
  pathname: string,
  body: unknown,
): unknown | undefined {
  const match = pathname.match(/^\/v1\/environments\/([^/]+)$/);
  if (!match) return undefined;
  const env = findEnvironment(state, decodeURIComponent(match[1]!));
  Object.assign(env, body as Partial<Environment>, {
    updatedAt: "2026-07-15T12:00:00.000Z",
  });
  return env;
}

/** `DELETE /v1/environments/:id` — hard delete; `false` if unmatched. */
export function environmentsDel(
  state: EnvironmentsState,
  pathname: string,
): boolean {
  const match = pathname.match(/^\/v1\/environments\/([^/]+)$/);
  if (!match) return false;
  const env = findEnvironment(state, decodeURIComponent(match[1]!));
  state.environments.splice(state.environments.indexOf(env), 1);
  return true;
}
