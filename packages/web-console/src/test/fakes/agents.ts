/**
 * `/v1/agents` family of the {@link FakeConsoleApi} (WP-C3-prep; write paths
 * refined for WP-C3.1). Basic CRUD in-memory: create (applies the submitted
 * config), PATCH (field-level config merge like the backend's `mergeConfig`,
 * increments `currentVersion` and records a version; 409 on an archived
 * agent), archive (terminal), list with the `?name=` filter, version history.
 */
import type {
  Agent,
  AgentConfig,
  AgentCreate,
  AgentUpdate,
  AgentVersion,
} from "@pi-managed/contracts";

import { ConsoleApiError } from "../../api/client.js";
import { notFound, pageOf } from "./wire.js";

const DEFAULT_CONFIG: AgentConfig = {
  model: { provider: "anthropic", id: "claude-sonnet-4" },
};

/** A full wire-shaped agent with overridable fields (contracts `Agent`). */
export function makeAgent(overrides: Partial<Agent> & { id: string }): Agent {
  return {
    name: "code-reviewer",
    currentVersion: 1,
    status: "active",
    config: DEFAULT_CONFIG,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

/** The slice of `FakeConsoleApi` state the agents family reads/writes. */
export interface AgentsState {
  agents: Agent[];
  agentVersions: Map<string, AgentVersion[]>;
}

function findAgent(state: AgentsState, id: string): Agent {
  const found = state.agents.find((a) => a.id === id);
  if (!found) throw notFound(id);
  return found;
}

/** `GET /v1/agents*` — the wire body, or `undefined` if unmatched. */
export function agentsGet(
  state: AgentsState,
  pathname: string,
  params: URLSearchParams,
): unknown | undefined {
  if (pathname === "/v1/agents") {
    const name = params.get("name");
    const matches = state.agents.filter((a) => !name || a.name === name);
    return pageOf(matches, params);
  }
  const versions = pathname.match(
    /^\/v1\/agents\/([^/]+)\/versions(?:\/([^/]+))?$/,
  );
  if (versions) {
    const id = decodeURIComponent(versions[1]!);
    findAgent(state, id);
    const all = state.agentVersions.get(id) ?? [];
    if (versions[2] !== undefined) {
      const version = all.find((v) => v.version === Number(versions[2]));
      if (!version) throw notFound(`${id} v${versions[2]}`);
      return version;
    }
    return pageOf(all, params);
  }
  const detail = pathname.match(/^\/v1\/agents\/([^/]+)$/);
  if (detail) return findAgent(state, decodeURIComponent(detail[1]!));
  return undefined;
}

/** `POST /v1/agents` + `POST …/archive` — or `undefined` if unmatched. */
export function agentsPost(
  state: AgentsState,
  pathname: string,
  body: unknown,
): unknown | undefined {
  if (pathname === "/v1/agents") {
    const { name, metadata, ...config } = body as AgentCreate;
    const agent = makeAgent({
      id: `agent_01TESTNEW${state.agents.length + 1}`,
      name,
      config: config as AgentConfig,
      ...(metadata ? { metadata } : {}),
    });
    state.agents.push(agent);
    state.agentVersions.set(agent.id, [
      { version: 1, config: agent.config ?? DEFAULT_CONFIG, createdAt: agent.createdAt },
    ]);
    return agent;
  }
  const archive = pathname.match(/^\/v1\/agents\/([^/]+)\/archive$/);
  if (archive) {
    const agent = findAgent(state, decodeURIComponent(archive[1]!));
    agent.status = "archived";
    return agent;
  }
  return undefined;
}

/** Archived agents are read-only (`PATCH` → 409, like the backend). */
function resourceArchived(id: string): ConsoleApiError {
  return new ConsoleApiError(
    `agent ${id} is archived; archived agents are read-only`,
    {
      status: 409,
      code: "resource_archived",
      type: "request_error",
      requestId: "req_01TESTREQUEST",
    },
  );
}

/** `PATCH /v1/agents/:id` — new immutable version; `undefined` if unmatched. */
export function agentsPatch(
  state: AgentsState,
  pathname: string,
  body: unknown,
): unknown | undefined {
  const match = pathname.match(/^\/v1\/agents\/([^/]+)$/);
  if (!match) return undefined;
  const agent = findAgent(state, decodeURIComponent(match[1]!));
  if (agent.status === "archived") throw resourceArchived(agent.id);
  const { name, metadata, ...configPatch } = body as AgentUpdate;
  if (typeof name === "string") agent.name = name;
  if (metadata) agent.metadata = metadata;
  // Field-level merge, like the backend's `mergeConfig` (domain/agent).
  const previous = agent.config ?? DEFAULT_CONFIG;
  agent.config = {
    ...previous,
    ...Object.fromEntries(
      Object.entries(configPatch).filter(([, value]) => value !== undefined),
    ),
  } as AgentConfig;
  agent.currentVersion += 1;
  agent.updatedAt = "2026-07-15T12:00:00.000Z";
  const versions = state.agentVersions.get(agent.id) ?? [];
  versions.unshift({
    version: agent.currentVersion,
    config: agent.config,
    createdAt: agent.updatedAt,
  });
  state.agentVersions.set(agent.id, versions);
  return agent;
}
