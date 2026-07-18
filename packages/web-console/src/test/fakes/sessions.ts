/**
 * `/v1/sessions` family of the {@link FakeConsoleApi} (state lives on the
 * main class; this module holds the maker + route handling — see `wire.ts`).
 * Mirrors the read surface (list filters + offset-cursor pagination, detail,
 * positional entries slice, usage, tree, idle-only outputs, and the WP-C4.1
 * post-compaction `/messages` view — empty for an unseeded session, like the
 * real route for a session with no log), the WP-C2.2 inbound-event post with
 * the backend's idle-only `user.message` guard, and the WP-C2.3 fork.
 */
import type { ConsoleApiError } from "../../api/client.js";
import { ConsoleApiError as ApiError } from "../../api/client.js";
import type { Session, SessionUsageResponse } from "@pi-managed/contracts";
import type { SessionEntryWire } from "../../api/sessions.js";

import { notFound, sessionNotIdle } from "./wire.js";

/** A full wire-shaped session with overridable fields (contracts `Session`). */
export function makeSession(
  overrides: Partial<Session> & { id: string },
): Session {
  return {
    agentId: "agent_01TESTAGENT",
    agentVersion: 1,
    environmentId: "env_01TESTENV",
    status: "idle",
    stopReason: null,
    // usdCost mirrors WP-C2.0: the server always sends the rollup.
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      usdCost: 0,
    },
    vaultIds: [],
    resources: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    lastActivityAt: "2026-07-01T00:00:00.000Z",
    forkedFromSessionId: null,
    ...overrides,
  };
}

/** The slice of `FakeConsoleApi` state the sessions family reads/writes. */
export interface SessionsState {
  sessions: Session[];
  entries: Map<string, SessionEntryWire[]>;
  usage: Map<string, SessionUsageResponse>;
  trees: Map<string, unknown>;
  outputs: Map<string, string[]>;
  messages: Map<string, unknown[]>;
  nextForkId: string;
  /** See {@link import("../fake-console-api.js").FakeConsoleApi.wakeOnMessage}. */
  wakeOnMessage: boolean;
  /** Contents of every accepted `user.message`, in order. */
  acceptedUserMessages: string[];
  addSession(overrides: Partial<Session> & { id: string }): Session;
}

/** `GET /v1/sessions` — filters + offset-cursor pagination (opaque to the UI). */
function listSessions(
  state: SessionsState,
  params: URLSearchParams,
): { data: Session[]; nextCursor: string | null } {
  const status = params.get("status");
  const stopReason = params.get("stopReason");
  const agentId = params.get("agentId");
  const environmentId = params.get("environmentId");
  const limit = Number(params.get("limit") ?? "50");
  const offset = Number(params.get("cursor") ?? "0");

  const matches = state.sessions
    .filter(
      (s) =>
        (!status || s.status === status) &&
        (!stopReason || s.stopReason === stopReason) &&
        (!agentId || s.agentId === agentId) &&
        (!environmentId || s.environmentId === environmentId),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const data = matches.slice(offset, offset + limit);
  const nextCursor =
    offset + limit < matches.length ? String(offset + limit) : null;
  return { data, nextCursor };
}

/** `GET /v1/sessions/:id/entries` — positional `?from=&to=&limit=` slice. */
function listEntries(
  state: SessionsState,
  id: string,
  params: URLSearchParams,
): { data: SessionEntryWire[]; nextCursor: null } {
  const from = Number(params.get("from") ?? "0");
  const to = params.get("to");
  const limit = Number(params.get("limit") ?? "200");
  const data = (state.entries.get(id) ?? [])
    .filter((e) => e.seq >= from && (to === null || e.seq <= Number(to)))
    .slice(0, limit);
  return { data, nextCursor: null };
}

/** `GET /v1/sessions*` — the wire body, or `undefined` if unmatched. */
export function sessionsGet(
  state: SessionsState,
  pathname: string,
  params: URLSearchParams,
): unknown | undefined {
  if (pathname === "/v1/sessions") return listSessions(state, params);
  const detail = pathname.match(
    /^\/v1\/sessions\/([^/]+)(?:\/(entries|usage|tree|outputs|messages))?$/,
  );
  if (!detail) return undefined;
  const id = decodeURIComponent(detail[1]!);
  const session = state.sessions.find((s) => s.id === id);
  if (!session) throw notFound(id);
  if (detail[2] === "entries") return listEntries(state, id, params);
  if (detail[2] === "usage") {
    return (
      state.usage.get(id) ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        usdCost: 0,
      }
    );
  }
  if (detail[2] === "tree") {
    return state.trees.get(id) ?? { root: null, branches: [] };
  }
  if (detail[2] === "outputs") {
    // Idle-only, like the real route (409 session_not_idle otherwise).
    if (session.status !== "idle") throw sessionNotIdle(session.status);
    return { data: (state.outputs.get(id) ?? []).map((name) => ({ name })) };
  }
  if (detail[2] === "messages") {
    // The `{data}` envelope without `nextCursor` (small bounded collection).
    return { data: state.messages.get(id) ?? [] };
  }
  return session;
}

/** `POST /v1/sessions/:id/{events,fork}` — or `undefined` if unmatched. */
export function sessionsPost(
  state: SessionsState,
  pathname: string,
  body: unknown,
): unknown | undefined {
  const events = pathname.match(/^\/v1\/sessions\/([^/]+)\/events$/);
  if (events) {
    const id = decodeURIComponent(events[1]!);
    const session = state.sessions.find((s) => s.id === id);
    if (!session) throw notFound(id);
    // Mirror the backend guard (`api/events.ts` ROB-5): a user.message may
    // only start/continue a turn while the session is idle.
    const type = (body as { type?: unknown } | null)?.type;
    if (type === "user.message" && session.status !== "idle") {
      throw sessionBusy(session.status);
    }
    if (type === "user.message") {
      const content = (body as { content?: unknown }).content;
      if (typeof content === "string") state.acceptedUserMessages.push(content);
      // Model the backend wake: an accepted user.message runs a turn, so a
      // second one can only be accepted after the session returns to idle
      // (the ROB-5 one-per-turn guard). Opt-in — most tests script status.
      if (state.wakeOnMessage) {
        session.status = "running";
        session.stopReason = null;
      }
    }
    // Accepted (202): work proceeds asynchronously — tests script the
    // session's reaction (status flip, stream frames) explicitly.
    return { accepted: true };
  }
  const fork = pathname.match(/^\/v1\/sessions\/([^/]+)\/fork$/);
  if (fork) {
    const id = decodeURIComponent(fork[1]!);
    const parent = state.sessions.find((s) => s.id === id);
    if (!parent) throw notFound(id);
    // Mirror the backend (`domain/session/fork.ts`): a new session sharing
    // the parent's config, `forkedFromSessionId` set, "(fork)" title suffix.
    return state.addSession({
      id: state.nextForkId,
      agentId: parent.agentId,
      agentVersion: parent.agentVersion,
      environmentId: parent.environmentId,
      ...(parent.title ? { title: `${parent.title} (fork)` } : {}),
      forkedFromSessionId: parent.id,
    });
  }
  return undefined;
}

function sessionBusy(status: string): ConsoleApiError {
  return new ApiError(
    `session is ${status}; wait for it to return to idle before sending another user.message`,
    {
      status: 409,
      code: "session_not_idle",
      type: "request_error",
      requestId: "req_01TESTREQUEST",
    },
  );
}
