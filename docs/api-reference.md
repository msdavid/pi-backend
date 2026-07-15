# API Reference — Conventions

> **Purpose.** This is the **wire contract** for the Pi Managed Backend REST + SSE API.
> `spec.md` is feature-level: it names resources and operations. This document pins the
> wire — JSON shapes, HTTP status codes, error taxonomy, pagination cursors, event-type
> strings, and the cross-cutting semantics every resource family must conform to. It is
> the synchronization artifact for parallel API implementation: later work packages
> (WP-0.3 … WP-0.6) append resource-family sections below and **must** conform to the
> conventions defined here.
>
> **Authority.** When `spec.md` and this document disagree, `spec.md` is authoritative;
> report contradictions, do not pick silently. Event-type strings (§Event-type naming) are
> **FINAL** per `docs/decisions.md` item 1.
>
> **Status:** WP-0.2 (conventions section). Resource-family sections are stubbed below.

## Table of contents

Conventions:

1. [Versioning & base path](#versioning--base-path)
2. [Authentication](#authentication)
3. [Error envelope](#error-envelope)
4. [HTTP status-code policy](#http-status-code-policy)
5. [Cursor pagination](#cursor-pagination)
6. [`Idempotency-Key`](#idempotency-key)
7. [Rate limiting](#rate-limiting)
8. [ID format](#id-format)
9. [Name rules](#name-rules)
10. [Timestamps](#timestamps)
11. [`metadata` rules](#metadata-rules)
12. [Event-type naming scheme](#event-type-naming-scheme)
13. [SSE wire format](#sse-wire-format)
14. [Tenancy](#tenancy)
15. [Conformance checklist](#conformance-checklist)

Resource-family sections (appended by later work packages):

- Agents — TODO — WP-0.3
- Environments — TODO — WP-0.3
- Sessions — TODO — WP-0.3
- Events & SSE — TODO — WP-0.4
- Vaults — TODO — WP-0.5
- Memory stores — TODO — WP-0.5
- Files — TODO — WP-0.5
- Skills — TODO — WP-0.5
- Outcomes — TODO — WP-0.5
- Jobs — TODO — WP-0.6
- Webhooks — TODO — WP-0.6
- Tenant / admin — TODO — WP-0.6
- Self-hosted work queue — TODO — WP-0.6

## Versioning & base path

All API paths are prefixed with `/v1`. Example: `POST https://<host>/v1/agents`.

The `/v1` prefix is the major version. Breaking changes require a new major prefix
(`/v2`); additive, backward-compatible changes (new fields, new event types, new optional
parameters) do not increment the major version. Clients must ignore unrecognized fields
in responses.

## Authentication

Every request must carry an API key:

```
Authorization: Bearer <api_key>
```

- API keys are **tenant-scoped** (§Tenancy). The tenant context is derived from the key.
- Keys are stored **hashed** (argon2id) server-side; the raw key is shown **once** at
  issuance (`POST /v1/api-keys`).
- A revoked or deleted key immediately fails authentication with `401 unauthorized`.
- The Pi client extension may use an extension-specific bearer token in place of a raw API
  key; see spec §24 (client extension) for that flow. Both forms resolve to the same
  tenant context.
- Requests without a valid `Authorization` header receive `401 unauthorized`.

### Authorization scopes

Every API key carries a set of **scopes**; every route is guarded by a method→scope map
(`requireScopeByMethod`):

| Scope | Grants |
|---|---|
| `read` | `GET`/`HEAD` requests. |
| `write` | Mutating requests (`POST`/`PATCH`/`PUT`/`DELETE`), plus everything `read` grants. |
| `admin` | Everything, including key management. |

- A request whose key lacks the required scope fails with **`403 forbidden`**.
- **New keys default to `["read"]`** (least privilege) — pass `scopes` on
  `POST /v1/api-keys` to mint a key that can mutate.
- `self_hosted_worker:<envId>` keys (issued via `POST /v1/environments/:id/worker-keys`)
  are valid **only** for the self-hosted work-queue routes and are denied (`403`) on every
  other guarded route.

## Error envelope

All errors use a single wire shape:

```json
{
  "error": {
    "type": "request_error",
    "code": "invalid_request",
    "message": "Human-readable description of the failure.",
    "details": { },
    "requestId": "req_01HXXXXXXXXXXXXXXX"
  }
}
```

- `type` — coarse error class for client branching (e.g. `request_error`,
  `authentication_error`, `server_error`). The machine-stable discriminator is `code`.
- `code` — machine-readable error code from the taxonomy below. Stable; clients may
  branch on it.
- `message` — human-readable, may change without notice; never parse it.
- `details` — optional object with structured, code-specific context (field paths,
  conflicting IDs, blocking event IDs). Omitted when empty.
- `requestId` — server-generated, correlated in logs and telemetry. Always present.

### Error `code` taxonomy

| `code` | Meaning |
|---|---|
| `invalid_request` | Malformed or semantically invalid request (400/422 — see status policy). |
| `not_found` | The referenced resource does not exist (or exists in another tenant — same response to avoid leakage). |
| `unauthorized` | Missing or invalid credentials. |
| `forbidden` | Authenticated, but the key/role lacks permission for this action. |
| `conflict` | The request conflicts with current state (e.g. duplicate name, archived resource referenced). |
| `rate_limited` | Tenant rate-limit or quota exceeded. |
| `payload_too_large` | Request body or upload exceeds the size limit. |
| `internal_error` | Unexpected server failure. |
| `resource_archived` | Operation attempted on an archived (terminal, read-only) resource. |
| `budget_exhausted` | Session `budget` hard cap exceeded; session interrupted and set `idle`. |
| `requires_action` | Session cannot accept the event while idle with a pending blocking action (`stopReason: requires_action`). |
| `session_not_idle` | Operation requires the session to be `idle`; it is currently `running`/`rescheduling`/`terminated`. |
| `idempotency_conflict` | An `Idempotency-Key` was reused with a different request body (409). |

Internal errors extend a single `BackendError` base class carrying the machine-readable
`code` (CONVENTIONS.md, "Errors"). The wire shape above is the only shape a client ever
sees.

## HTTP status-code policy

| Status | Meaning | When |
|---|---|---|
| `200 OK` | Successful read or synchronous mutation returning a body. | `GET`, `PATCH` returning the resource, `POST` actions returning a result. |
| `201 Created` | Resource created. | `POST` create endpoints. |
| `202 Accepted` | Request accepted for asynchronous processing. | Manual job triggers, webhook tests, async actions. |
| `204 No Content` | Successful mutation with no response body. | `DELETE`, some `archive`/`pause`/`unpause` actions. |
| `400 Bad Request` | Malformed JSON, missing required header, or unreadable body. | Use `code: invalid_request`. |
| `401 Unauthorized` | Missing or invalid credentials. | `code: unauthorized`. |
| `403 Forbidden` | Authenticated but not permitted. | `code: forbidden`. |
| `404 Not Found` | Resource does not exist (or is in another tenant). | `code: not_found`. |
| `409 Conflict` | State conflict, including idempotency-key reuse with a different body. | `code: conflict` or `idempotency_conflict`. |
| `422 Unprocessable Entity` | Body is valid JSON but fails semantic/validation rules. | `code: invalid_request` with field-level `details`. |
| `429 Too Many Requests` | Rate-limited or quota-exceeded. | `code: rate_limited`; include `Retry-After`. |
| `500 Internal Server Error` | Unexpected server failure. | `code: internal_error`. |
| `503 Service Unavailable` | Temporary unavailability (e.g. dependency down, capacity). | Retry with backoff. |

**400 vs 422:** `400` = the request could not be parsed/decoded (malformed JSON, missing
mandatory header, unreadable multipart). `422` = the request parsed but failed semantic
validation (zod schema rejection, invalid enum value, bad ID format). Both use
`code: invalid_request`; the status distinguishes the failure class.

## Cursor pagination

Most list endpoints are cursor-paginated and accept:

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `limit` | integer | `50` | Maximum `200`. Clamped if larger. |
| `cursor` | string | — | Opaque cursor from a previous response's `nextCursor`. |

Response shape:

```json
{
  "data": [ /* resource objects */ ],
  "nextCursor": "eyJzIjoxMjM0NTYifQ"
}
```

- `nextCursor` is `null` when the end of the result set has been reached; otherwise
  non-null and to be passed verbatim as `?cursor=` on the next request.
- The cursor is an opaque **base64url** string. Clients must not construct, parse, or
  depend on its internal structure.
- Cursors are **position-stable**: a cursor encodes a position in the ordered result set
  and remains valid for replay from that position even if new rows are inserted ahead of
  it. (Newly inserted rows may appear on subsequent pages.)
- **Default sort** is `createdAt` **descending** (newest first), unless a resource family
  documents otherwise (e.g. session entries sort by sequence position — see WP-0.4).
- Resource families may add filter query parameters (`?status=`, `?name=`,
  `?metadata.<key>=`); filters do not change the pagination contract.
- **Small bounded collections do not page:** `GET /v1/vaults`,
  `GET /v1/vaults/:id/credentials`, `GET /v1/webhooks`, and `GET /v1/api-keys` return the
  full set with `nextCursor: null`; `GET /v1/skills/:id/versions` and
  `GET /v1/sessions/:id/messages` return `{"data": [...]}` with no `nextCursor` field.

## `Idempotency-Key`

Every mutating `POST` (and any `DELETE`/`PATCH` that creates a side effect a client might
retry) accepts an `Idempotency-Key` header:

```
Idempotency-Key: <client-generated unique string>
```

- **Required for** the Pi client extension and the scheduler (cron/manual triggers) on all
  mutating `POST`s. Recommended for all clients.
- **Replay returns the stored response byte-for-byte** (same status, headers, body) for
  the original request. Exception: **credential-issuing routes never store the response**
  (`POST /v1/api-keys`, `POST /v1/webhooks` — the secret is shown once); replaying their
  key returns `409` with `code: idempotency_conflict` — list and revoke/re-create instead.
- **Same key + different request body = `409` with `code: idempotency_conflict`.** The
  comparison is over the normalized request body and the effective resource path; trivial
  whitespace differences are ignored.
- **Concurrent in-flight requests with the same key**: the first request claims the key
  before its handler runs; a second request arriving while the first is still in flight
  gets `409 idempotency_conflict` ("already in progress"). A claim abandoned by a crashed
  handler is reclaimable after a 5-minute lease.
- **Window:** the stored response is retained for **24 hours**, after which the key may be
  reused and a new request is processed normally.
- **Scope:** idempotency is **per-tenant**. A key is only unique within the tenant that
  issued it.
- Only `POST` (and idempotent-by-construction `DELETE`) is covered; `PATCH` updates that
  create new versions are not idempotent unless explicitly stated by the resource family.

## Rate limiting

Rate-limited responses use status `429` and include a `Retry-After` header (seconds):

```
HTTP/1.1 429 Too Many Requests
Retry-After: 12
Content-Type: application/json

{"error":{"type":"rate_limited","code":"rate_limited","message":"Tenant rate limit exceeded.","requestId":"..."}}
```

- Limiting is a **per-tenant token bucket** (per spec §27.3: quotas enforced at the API
  and scheduler).
- Every response (not only 429s) carries rate-limit headers:

| Header | Meaning |
|---|---|
| `X-RateLimit-Limit` | Maximum requests allowed in the current window. |
| `X-RateLimit-Remaining` | Requests remaining in the current window. |
| `X-RateLimit-Reset` | Unix timestamp (seconds) at which the window resets. |

- Quota-exceeded conditions (concurrent sessions/sandboxes/jobs, vault size, etc.) are
  also surfaced as `429` + `code: rate_limited` with a descriptive `message`; these are
  distinct from short-window request throttling but use the same status code. Quota 429s
  carry `Retry-After: 60`, `X-Quota-Limit`, `X-Quota-Remaining`, and `X-Quota-Resource`
  headers plus `details: {resource, limit, current}` in the error envelope.

## ID format

- IDs are **prefixed, ULID-payload, server-generated**, opaque strings.
- Generated server-side; never accepted from the client on creation.
- Clients must treat IDs as opaque strings (do not parse, slice, or assume structure
  beyond the prefix for display).

Prefixes:

| Prefix | Resource |
|---|---|
| `agent_` | Agent |
| `env_` | Environment |
| `sess_` | Session |
| `vault_` | Vault |
| `vcred_` | Vault credential |
| `mem_` | Memory store |
| `memver_` | Memory version |
| `skill_` | Skill |
| `file_` | Uploaded file |
| `job_` | Scheduled job |
| `wh_` | Webhook endpoint |
| `whsec_` | Webhook signing secret |
| `apikey_` | API key |
| `outc_` | Outcome |
| `evt_` | Event |
| `tnt_` | Tenant |

## Name rules

Human-readable `name` fields (present on every creatable resource):

- Length: **1–128 characters**.
- **Unique within (tenant, resource-type).** A duplicate name yields `409 conflict`.
- Allowed characters: Unicode letters, numbers, spaces, hyphens (`-`), and underscores
  (`_`).
- Disallowed: control characters and the forward slash (`/`).
- Used for display and stable reference. microsandbox sandbox names are derived from
  session IDs and namespaced by tenant (`t<tenantId>-s<sessionId>`, spec §27.2) — these
  are internal and not subject to the user-facing name rules.

## Timestamps

- All timestamps are **RFC 3339**, UTC, with the trailing `Z` (e.g.
  `2026-07-12T09:30:00.123Z`).
- Every resource carries `createdAt` and `updatedAt`. Immutable resources (archived,
  read-only) freeze `updatedAt` at archive time.
- Resource families may add additional timestamps (e.g. `archivedAt`, `lastActivityAt`,
  `processedAt` on events); all must follow this format.

## `metadata` rules

Arbitrary `metadata` fields (present on most creatable resources):

- A **JSON object** (not an array, not a scalar).
- Maximum encoded size: **4 KiB**. Larger payloads are rejected with
  `code: invalid_request` (422).
- **Keys** match `[a-zA-Z0-9_.-]+` (one or more of ASCII letters, digits, underscore,
  dot, hyphen). Other key characters are rejected.
- **Values** are scalars only: `string`, `number`, `boolean`, or `null`.
- **No nested objects or arrays** as values.
- `metadata` is never indexed for query by default; resource families that expose
  `metadata`-based filtering document the supported keys.

## Event-type naming scheme

Persisted event types follow `{domain}.{action}` (spec §9.1). Example:
`user.message`, `session.status_idle`, `agent.tool_use`, `span.model_request_start`.

- The `{domain}` is one of `user`, `system`, `session`, `agent`, `span`.
- The `{action}` is a snake_case verb or state.
- **Stream-only preview events are the exception** (see SSE wire format):
  `event_start` and `event_delta` do not follow `{domain}.{action}` and are never
  persisted.
- Every persisted event carries a `processedAt` timestamp; `null` means the event is
  **queued** and will be handled after preceding events finish (spec §9.1).

> **FINAL (per `docs/decisions.md` item 1, resolved 2026-07-12):** The provisional
> §9.2 event-type names below are accepted as final. They are not TBD. Wire JSON schemas
> for each event land in WP-0.4.

### Persisted event catalog (FINAL)

| Type | Dir | Description |
|---|---|---|
| `user.message` | in | User message (text). Start/continue work. |
| `user.interrupt` | in | Stop mid-execution; follow with `user.message` to redirect. |
| `user.custom_tool_result` | in | Response to a custom-tool call. |
| `user.tool_confirmation` | in | Approve/deny a tool call a permission policy requires (`allow`/`deny` + optional `denyMessage`). |
| `user.define_outcome` | in | Define an outcome (§16). |
| `user.tool_result` | in | **Self-hosted environments only** — your worker provides tool results. |
| `system.message` | in | Update the system prompt between turns. Model-dependent; see §9.4. |
| `session.status_idle` | out | Awaiting input (includes `stopReason`, e.g. `requires_action` + blocking event IDs). |
| `session.status_run_started` | out | Transition to `running`. |
| `session.status_rescheduled` / `session.status_terminated` | out | Retry / terminal error. |
| `session.error` | out | Error (MCP failures carry `mcpServerName` + `retryStatus`). |
| `session.thread_*` | out | Multi-agent thread lifecycle/communication (§18). |
| `session.outcome_evaluation_*` | out | Outcome grader lifecycle (§16). |
| `agent.message` | out | Agent's buffered response text (authoritative record). |
| `agent.thinking` | out | Agent's thinking block. |
| `agent.tool_use` / `agent.mcp_tool_use` | out | Agent requests a tool call. |
| `agent.tool_result` | out | Result of a server-executed tool. |
| `agent.custom_tool_use` | out | Agent requests a custom-tool call (you execute). |
| `agent.thread_message_received` / `agent.thread_message_sent` | out | Multi-agent inter-thread messages. |
| `span.model_request_start` / `span.model_request_end` | out | Per-model-request boundaries. |
| `span.outcome_evaluation_*` | out | Outcome grader lifecycle. |

Notes on the catalog:

- `agent.message` is the **authoritative** buffered response text. Live incremental
  previews arrive as stream-only `event_delta` frames and are reconciled against the
  buffered event (see SSE wire format).
- `session.status_idle` carries a `stopReason`; the value `requires_action` is accompanied
  by blocking `eventIds` that the client must respond to (custom-tool results, tool
  confirmations). This is the source of the `requires_action` and `session_not_idle`
  error codes.
- Wildcard-suffixed types (`session.thread_*`, `session.outcome_evaluation_*`,
  `span.outcome_evaluation_*`) denote a family; concrete subtypes are enumerated in
  WP-0.4 (Events & SSE) and the multi-agent / outcome sections (spec §16, §18).

## SSE wire format

The live event stream (`GET /v1/sessions/:id/stream`) is Server-Sent Events:

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

Each persisted event is delivered as one SSE frame:

```
id: <seq>
event: <type>
data: <json>

```

- `id` — the event's **sequence position** in the session log (a monotonically increasing
  integer). This is the cursor used for replay.
- `event` — the event type from the catalog above.
- `data` — the event JSON object, on a single line (or multiple `data:` lines per the SSE
  spec, reassembled by the client).
- Frames are separated by a blank line (`\n\n`).

### Reconnect & replay (persisted events)

- On reconnect, the client sends `Last-Event-ID: <seq>` (standard SSE).
- The backend replays persisted events with sequence position **greater than** the
  `Last-Event-ID`, so buffered events are **gap-free across drops** without a separate
  history call (spec §9.3).
- Clients that have no `Last-Event-ID` (first connect) may start from the head of the
  stream, or fetch persisted history via `GET /v1/sessions/:id/events` (paginated) and
  then connect with `Last-Event-ID` set to the last historical sequence.

### Live deltas (stream-only, opt-in, never replayed)

By default, agent text arrives as buffered `agent.message` events. Clients may opt in to
incremental previews via a query parameter (e.g. `?eventDeltas=agent.message`):

- `event_start` — announces an upcoming buffered event: `{type, id}`.
- `event_delta` — incremental text, keyed by `eventId` + `delta.index`.
- The buffered event (`agent.message` / `agent.thinking`) then reconciles and is
  authoritative.
- `agent.thinking`: `event_start` only (content arrives in the buffered event).
- **Deltas are never persisted and never replayed on reconnect.** A reconnected client
  receives buffered events from `Last-Event-ID` onward, not the deltas it missed; reopen
  the stream to resume deltas.
- Primary thread only; text only.

## Tenancy

- The tenant context is **resolved from the API key** on every request (spec §27.1).
- Every resource is scoped to a `tenantId`. Every database query applies row-level
  filtering on `tenantId`. Cross-tenant access is impossible by construction.
- `tenantId` is **never client-supplied** on resource creation — it is always derived from
  the authenticated caller. A request body containing `tenantId` is rejected with
  `code: invalid_request` (422).
- Sandbox names are tenant-namespaced (`t<tenantId>-s<sessionId>`, spec §27.2); the
  namespace partitioning is internal and invisible to clients.
- In the self-hosted single-tenant deployment shape there is one implicit tenant; the
  tenant context still flows through every request, so promoting to multi-tenant SaaS is
  a config change, not a rewrite (spec §7.1).

## Conformance checklist

Later work packages (WP-0.3 … WP-0.6) must confirm each of the following before their
section is considered complete. Tick every box; if a box cannot be ticked, stop and
report.

- [ ] All resource paths are under `/v1`.
- [ ] All mutating `POST`s document the `Idempotency-Key` header and its 24h / per-tenant
      / 409-on-different-body semantics.
- [ ] All list endpoints document `?limit=` (default 50, max 200) and `?cursor=`, and
      return `{data, nextCursor}`.
- [ ] All errors use the single error envelope with a `code` from the taxonomy above; no
      resource invent a new `code` without adding it here first.
- [ ] HTTP status codes follow the status-code policy (400 vs 422 distinction observed).
- [ ] Rate-limited responses are `429` + `Retry-After`, and rate-limit headers are present
      on normal responses.
- [ ] All resource IDs use the documented prefix and are server-generated; creation
      endpoints reject a client-supplied ID.
- [ ] All `name` fields enforce 1–128 chars, uniqueness within (tenant, resource-type),
      and the allowed character set.
- [ ] All timestamps are RFC 3339 UTC with `Z`; every resource has `createdAt`/`updatedAt`.
- [ ] All `metadata` fields enforce the 4 KiB cap, key regex, and scalar-only values.
- [ ] New event types follow `{domain}.{action}` (stream-only `event_start`/`event_delta`
      excepted) and carry `processedAt`; catalog additions are reflected in the table
      above and marked FINAL.
- [ ] SSE frames use `id:` (sequence position) / `event:` / `data:`; reconnect uses
      `Last-Event-ID`; deltas are documented as never-replayed.
- [ ] No resource accepts a client-supplied `tenantId`.
- [ ] The section cross-references the relevant `spec.md` §-numbers it implements.

---

## Agents

> **Spec:** §6.1, §8.1. A reusable, versioned definition of how a Pi agent behaves.

### `POST /v1/agents` — create

`Idempotency-Key` required.

Request body:
```json
{
  "name": "code-reviewer",
  "model": {"provider": "openai", "id": "gpt-4o", "thinkingLevel": "high"},
  "systemPrompt": "You are a meticulous code reviewer…",
  "tools": {
    "defaultConfig": {"enabled": true, "permissionPolicy": "always_allow"},
    "configs": {"bash": {"permissionPolicy": "always_ask"}}
  },
  "skills": [{"type": "prebuilt", "skillId": "skill_pdf"}],
  "extensions": [],
  "mcpServers": [],
  "multiagent": {"roster": []},
  "metadata": {"team": "platform"}
}
```

- `name`: 1–128 chars, unique within (tenant, resource-type). Required.
- `model`: `{provider, id, thinkingLevel?}`. Required.
- `systemPrompt`: string. Optional (a `SYSTEM.md` reference may substitute).
- `tools`: `{defaultConfig, configs}` (§11.1, §22.2). Optional; defaults to all built-ins
  enabled with `always_allow`.
- `skills`: array of `{type: 'prebuilt'|'custom', skillId, version?}`. ≤20 per session
  across all agents (§20.3).
- `extensions`: array of extension IDs/paths (managed features attach here).
- `mcpServers`: array of `{name, url, type: 'url'}` (§19.3). Max 20 per agent. Every
  `mcp_servers` entry must be referenced by an `mcp_toolset` entry in `tools`, and vice
  versa (§19.3 referential integrity — schema rejects dangling/unreferenced entries).
- `multiagent`: optional roster (§18.3).
- `metadata`: max 4 KiB, scalar values.

Response `201`:
```json
{
  "id": "agent_01J…",
  "name": "code-reviewer",
  "currentVersion": 1,
  "status": "active",
  "createdAt": "2026-07-13T12:00:00Z",
  "updatedAt": "2026-07-13T12:00:00Z",
  "metadata": {"team": "platform"}
}
```

Errors: `409 conflict` (`code: conflict`) on duplicate name; `422` on validation.

### `GET /v1/agents` — list

Query: `?limit=50&cursor=&name=&metadata.team=platform`. Response `200`: `{data: [...], nextCursor}`.

### `GET /v1/agents/:id` — retrieve

Response `200`: the agent resource (current version config expanded). `404 not_found` if
archived-or-not-yours.

### `PATCH /v1/agents/:id` — update (creates a new version)

Body: any subset of the create fields. **Creates a new immutable version**
(`currentVersion` increments). Returns `200` with the updated resource.

### `POST /v1/agents/:id/archive` — archive (terminal)

`Idempotency-Key` required. Archive is **terminal**: read-only, no unarchive, no new
sessions can reference it (§6.1). Returns `200` with `status: "archived"`. If a job
references this agent, the job is auto-archived in the same operation (§17.5).

### `GET /v1/agents/:id/versions` — list versions

Response `200`: `{data: [{version, config, createdAt}, ...], nextCursor}`.

### `GET /v1/agents/:id/versions/:ver` — retrieve a version

Response `200`: the versioned config blob. `404` if version doesn't exist.

---

## Environments

> **Spec:** §6.2, §8.2. Defines the sandbox configuration where sessions run.

### `POST /v1/environments` — create

`Idempotency-Key` required.

Request body:
```json
{
  "name": "python-env",
  "type": "cloud",
  "image": "ubuntu:22.04",
  "resources": {"cpus": 2, "memoryMiB": 2048, "diskMiB": 10240},
  "networking": {"mode": "unrestricted"},
  "packages": ["python3", "pip"],
  "mounts": [],
  "maxDuration": 3600,
  "idleTimeout": 300,
  "metadata": {}
}
```

- `type`: `cloud` or `self_hosted` (both supported, §10.4). Self-hosted sessions enforce
  an unsupported-features matrix at **session creation** (no memory stores, no
  environment-variable credentials) with `422`.
- `networking.mode`: `unrestricted` (compiles to microsandbox `publicOnly()` — NOT
  `allowAll()`) or `limited` (default-deny + `allowedHosts` explicit allows, §6.2/§10.5).
- Not versioned (§6.2).

Response `201`: the environment resource with `id: "env_…"`, `status: "active"`.

### `GET /v1/environments` — list

Query: `?limit=&cursor=&status=`. Response `200`: `{data, nextCursor}`.

### `GET /v1/environments/:id` — retrieve

Response `200`. `404` if not found or cross-tenant.

### `PATCH /v1/environments/:id` — update

Body: any subset. Returns `200` with the updated resource. (Not versioned — sessions
created later may use the new config.)

### `DELETE /v1/environments/:id` — delete (hard)

Returns `204`. Hard delete (§6.2). Running sessions continue; new sessions referencing it
fail with `404`.

### `POST /v1/environments/:id/archive` — archive

`Idempotency-Key` required. Returns `200` with `status: "archived"`. Archived environments
cannot be used for new sessions.

### `GET /v1/environments/:id/work-stats` — self-hosted queue depth

Response `200`: `{depth, pending, oldestQueuedAt, workersPolling}` (§10.4).

### `POST /v1/environments/:id/work-stop` — stop queued/claimed work

Org-key auth (not a worker key). Body: `{"force": false}` (optional). Returns `200` with
the stopped work item. See "Self-hosted work queue" below for the worker-side routes.

---

## Sessions

> **Spec:** §6.3, §8.3, §30 item 8. A running agent instance within an environment.

### `POST /v1/sessions` — create (provisions sandbox lazily, no work starts)

`Idempotency-Key` required.

Request body — the `agent` field has **three forms** (§6.3):

Form 1 — bare ID (latest version):
```json
{
  "agent": "agent_01J…",
  "environmentId": "env_01J…",
  "title": "fix the login bug",
  "resources": [],
  "vaultIds": ["vault_01J…"],
  "budget": {"maxTokens": 1000000, "maxUsd": 2.00},
  "metadata": {"userId": "u_123"}
}
```

Form 2 — pinned version: `{"agent": {"id": "agent_01J…", "version": 3}, ...}`

Form 3 — overrides (override `model`/`systemPrompt`/`tools`/`skills`/`extensions`/
`mcpServers` for this session only; does not modify the agent resource):
```json
{
  "agent": {"id": "agent_01J…", "overrides": {"model": {"provider": "openai", "id": "gpt-4o"}}},
  "environmentId": "env_01J…"
}
```

Override semantics: **omit → inherit; set null → clear; set value → full replace (no
merge)** (§6.3).

- `budget`: `{maxTokens?, maxUsd?}` hard caps. When exceeded → session interrupted →
  `idle` with `stopReason: budget_exhausted` (§6.3). The client extension's spend caps
  map to this field (§24.6).
- Creating a session provisions the sandbox **lazily** — no work starts until a
  `user.message` event is sent (§6.3).
- Rejects (`422`, `code: resource_archived`) if the agent or environment is archived.

Response `201`:
```json
{
  "id": "sess_01J…",
  "agentId": "agent_01J…",
  "agentVersion": 3,
  "environmentId": "env_01J…",
  "title": "fix the login bug",
  "status": "idle",
  "stopReason": null,
  "budget": {"maxTokens": 1000000, "maxUsd": 2.00},
  "usage": {"inputTokens": 0, "outputTokens": 0, "cacheCreationInputTokens": 0, "cacheReadInputTokens": 0},
  "vaultIds": ["vault_01J…"],
  "resources": [],
  "metadata": {"userId": "u_123"},
  "createdAt": "2026-07-13T12:00:00Z",
  "updatedAt": "2026-07-13T12:00:00Z",
  "lastActivityAt": "2026-07-13T12:00:00Z",
  "forkedFromSessionId": null
}
```

**State machine** (§6.3): `idle` → `running` → `rescheduling` (transient retry, 3 tries
with exp backoff 1s→4s→16s per decisions.md) → `terminated` (unrecoverable error). Starts
in `idle`. Idle sessions have their sandbox checkpointed (stopped, disk preserved).

### `GET /v1/sessions` — list

Query: `?limit=&cursor=&status=&agentId=&environmentId=`. Response `200`: `{data, nextCursor}`.

### `GET /v1/sessions/:id` — retrieve (status, usage, config)

Response `200`: the session resource above.

### `PATCH /v1/sessions/:id` — update agent.tools / agent.mcpServers (idle only)

Body: `{agent: {tools?, mcpServers?}}`. Full-replacement semantics (§6.3). Only `tools`
and `mcpServers` (incl. permission policies) can change without a new agent version;
`model`/`systemPrompt`/`skills` are fixed for the session's lifetime.

- **Session must be `idle` to update** — `409` (`code: session_not_idle`) if running.

### `DELETE /v1/sessions/:id` — delete (archives JSONL; independent resources untouched)

Returns `204`. Deleting a session does **not** delete its files, memory stores, vaults,
skills, environments, or agents (§6.3). The JSONL session tree is retained (archived) for
audit unless explicitly purged.

### `POST /v1/sessions/:id/fork` — fork

`Idempotency-Key` required.

A fork is a **new session resource sharing the JSONL tree up to the fork point**
(Pi-native tree fork, NOT a copy — §30 item 8 resolved). Returns `201` with the new
session (`forkedFromSessionId` set to the original). Edit-after-fork isolation: the fork
diverges from the fork point; the original is unaffected.

### `GET /v1/sessions/:id/entries` — list session log entries (positional slice)

Query: `?from=&to=&limit=` (positional — §5.1, §5.4).
Response `200`: `{data: [{seq, type, ...payload, processedAt}, ...], nextCursor}`.

### `GET /v1/sessions/:id/tree` — get the JSONL tree structure

Response `200`: the tree structure (branches, fork points).

### `GET /v1/sessions/:id/messages` — get the LLM-context messages (post-compaction)

Response `200`: the post-compaction message list (Pi's `session.messages` view, §A.2 #12).

### `GET /v1/sessions/:id/usage` — cumulative token usage

Response `200`:
```json
{
  "inputTokens": 12345,
  "outputTokens": 6789,
  "cacheCreationInputTokens": 0,
  "cacheReadInputTokens": 0,
  "usdCost": 0.12
}
```

Cache TTL is provider-dependent (§9.7); USD via per-model price table.

### `GET /v1/sessions/:id/metrics` — live sandbox resource sample (§26.4)

A point-in-time resource sample for the session's **running** microVM, pulled from the
microsandbox runtime when you call it (`SandboxProvider.metrics` → the msb SDK's
`SandboxHandle.metrics()`). It is a snapshot, not a time series: for a rate, take two
samples and difference the cumulative byte counters. The read does **not** wake, start,
or provision anything, so polling it is safe.

Scope: `read`. Tenant-scoped: a session belonging to another tenant is `404`, never `403`.

Response `200`:
```json
{
  "sessionId": "sess_01J9Z8Q6W1N2R3T4Y5U6I7O8P9",
  "cpuPercent": 42.5,
  "memoryBytes": 123456789,
  "memoryLimitBytes": 536870912,
  "diskReadBytes": 4096,
  "diskWriteBytes": 8192,
  "netRxBytes": 1024,
  "netTxBytes": 2048,
  "uptimeMs": 61000,
  "sampledAt": "2026-07-14T12:00:00.000Z"
}
```

| Field | Meaning |
|---|---|
| `cpuPercent` | CPU usage as a percentage of one core (100 = one core saturated). |
| `memoryBytes` / `memoryLimitBytes` | Guest resident memory, and the ceiling it was provisioned with. |
| `diskReadBytes` / `diskWriteBytes` | **Cumulative** bytes read/written since VM boot. |
| `netRxBytes` / `netTxBytes` | **Cumulative** bytes received/transmitted since VM boot. |
| `uptimeMs` | Time since the VM booted. |
| `sampledAt` | When the sample was taken (RFC 3339). |

`404 not_found` — the session does not exist / is archived / belongs to another tenant,
**or there is nothing to sample**: the sandbox has not been provisioned yet (sandboxes are
lazy — a freshly created session has no VM until its first turn), it is checkpointed
(`idle` sessions are stopped, §10.3), it crashed, or it was destroyed. The endpoint never
returns a fabricated zero sample to paper over a missing VM.

Known limitations — read these before building on it:

- **`self_hosted` environments have no metrics** (§10.4). Execution happens on the
  subscriber's own machine and the control plane owns no VM to measure, so the endpoint is
  always `404` for those sessions. It reports nothing rather than inventing numbers.
- **Multi-host mode (`SANDBOX_MODE=multi`) does not report metrics yet.** The backend-side
  client is implemented (`MultiHostSandboxProvider.metrics` → `POST /metrics` on the owning
  host agent), but the host-agent HTTP server does not serve that route yet, so the call
  yields "no metrics" and the endpoint answers `404`. Single-host mode
  (`SANDBOX_MODE=single`, the default) is fully functional.
- There is **no metrics stream and no OTLP export** of these values today — see
  `docs/observability.md` §3 for exactly what is and is not emitted.

### `GET /v1/sessions/:id/outputs` — list session output files

Lists the files the agent wrote to `/mnt/session/outputs/` (§16.6, §21). Idle-only —
`409` (`code: session_not_idle`) while the session is running.

### `GET /v1/sessions/:id/outputs/:filename` — download an output file

Streams the file content. Idle-only (`409 session_not_idle`); filenames are validated
against path traversal.

---

## Events & SSE

> **Spec:** §8.4, §9.1–9.3, §9.6–9.7. The send/stream surface. Event history is persisted
> in the session log (the JSONL tree) and fetchable in full.

### `POST /v1/sessions/:id/events` — send a user.* or system.* event

`Idempotency-Key` required.

The `user.message` event **starts or continues work**. `user.interrupt` redirects. The
event catalog (§9.2, marked FINAL in the Conventions section) defines all persisted types.

Success response for every inbound event: `202` with `{"accepted": true}`.

#### `user.message`
```json
{"type": "user.message", "content": "Fix the login bug in auth.ts"}
```
On an `idle` session: re-provisions (starts) the sandbox and continues. On a `running`/
`rescheduling` session: **rejected with `409` (`code: session_not_idle`)** — use
`user.interrupt` to intervene mid-turn, then follow with a new `user.message`.

#### `user.interrupt`
```json
{"type": "user.interrupt"}
```
Stop mid-execution. Follow with `user.message` to redirect.

#### `system.message` (mid-conversation system update)
```json
{"type": "system.message", "content": "Updated system prompt…"}
```
Pi rebuilds the system prompt per turn (`before_agent_start` / `systemPromptOverride`,
§9.6). **Not model-dependent.** The practical cost is prompt-cache invalidation.
**Cannot be sent while idle with `stopReason: requires_action`** — `409`
(`code: requires_action`).

#### `user.tool_confirmation` (permission-policy flow, §9.5)
```json
{
  "type": "user.tool_confirmation",
  "eventId": "evt_01J…",
  "decision": "allow"
}
```
`decision`: `allow` | `deny` (with optional `denyMessage`). Sent per blocking event ID.
Denied tools return a tool result saying the call was rejected (including `denyMessage`).
Returns the session to `running`.

#### `user.custom_tool_result` (custom-tool flow, §9.4)
```json
{
  "type": "user.custom_tool_result",
  "customToolUseId": "evt_01J…",
  "result": "…tool output…"
}
```
Response to an `agent.custom_tool_use` event. Pass the blocking event ID as
`customToolUseId`. Returns the session to `running`.

#### `user.tool_result` (self-hosted environments only, §9.2)
**Self-hosted environments only** — the worker provides tool results. `422`
(`code: invalid_request`) on cloud environments.

#### `user.define_outcome` (§16)
```json
{
  "type": "user.define_outcome",
  "description": "Refactor auth.ts to use async/await",
  "rubric": {"type": "text", "content": "…rubric markdown…"},
  "maxIterations": 3
}
```
`rubric`: `{type: 'text', content}` or `{type: 'file', fileId}`. `maxIterations` default 3,
max 20 (§16.3). One outcome at a time per session (§16.5).

Response `202` (accepted/async) with `{accepted: true}`. Work proceeds asynchronously;
listen on the stream for `session.outcome_evaluation_*` and `span.outcome_evaluation_*`.

### `GET /v1/sessions/:id/events` — list persisted events (paginated history)

Query: `?limit=&cursor=`. Response `200`: `{data: [{seq, type, ...payload, processedAt}], nextCursor}`.

### `GET /v1/sessions/:id/stream` — SSE stream (live + optional event deltas)

Query: `?eventDeltas=agent.message,agent.thinking` (opt-in, comma-separated);
`?from=<position>` to start replay from a specific sequence position.

Returns `text/event-stream`. Each frame:
```
id: <seq>
event: <type>
data: <json>

```
The SSE `id` is the event's **sequence position** in the session log. On reconnect, send
`Last-Event-ID` (standard SSE) and the backend replays persisted events from that position
— buffered events are gap-free across drops (§9.3). **Deltas are never replayed.**
A first connect with neither `Last-Event-ID` nor `?from=` replays the full persisted
history from position 0 before going live.

#### Live deltas (opt-in, stream-only, never persisted)

When `eventDeltas` includes `agent.message`:
```
event: event_start
data: {"eventId": "evt_01J…", "type": "agent.message"}

event: event_delta
data: {"eventId": "evt_01J…", "index": 0, "text": "Fixing "}

event: event_delta
data: {"eventId": "evt_01J…", "index": 1, "text": "the login"}

id: 42
event: agent.message
data: {"content": "Fixing the login bug…", …}
```
- `event_start` announces the upcoming event `type` + `id`.
- `event_delta` carries incremental text keyed by `eventId` + `delta.index`.
- The buffered `agent.message` (with SSE `id`) reconciles and is authoritative.
- `agent.thinking`: `event_start` only (content arrives in the buffered event).
- Deltas live **only** on the connection that opted in; no replay on reconnect. Primary
  thread, text only.

#### Outbound event payloads (selected)

`session.status_idle`:
```json
{"type": "session.status_idle", "stopReason": "requires_action", "blockingEventIds": ["evt_01J…", "evt_01K…"]}
```
`stopReason` values: `requires_action` (§9.4/§9.5), `budget_exhausted` (§6.3),
`user_interrupt`, `error`, `completed`.

`session.error` (MCP failures, §19.6):
```json
{"type": "session.error", "mcpServerName": "github-mcp", "retryStatus": "mcp_authentication_failed_error"}
```
`retryStatus`: `mcp_connection_failed_error` | `mcp_authentication_failed_error`. Retried on
the next `idle` → `running` transition.

`agent.tool_use` / `agent.mcp_tool_use`:
```json
{"type": "agent.tool_use", "tool": "bash", "input": {"cmd": "ls"}, "eventId": "evt_01J…"}
```

`agent.tool_result`:
```json
{"type": "agent.tool_result", "tool": "bash", "output": "file1.ts\nfile2.ts", "truncated": false}
```

`span.model_request_start` / `span.model_request_end` bound per-model-request activity
(per-turn observability + reconciling preview deltas, §26.3).

---

## Vaults

> **Spec:** §8.5, §12 (except §12.3 refresh → Phase 2), §25.1, §25.4. Collections of
> credentials registered once and referenced by ID at session creation. Sensitive fields
> are write-only.

### `POST /v1/vaults` — create vault

`Idempotency-Key` required. Body: `{name, metadata?}`. Response `201`:
`{id: "vault_…", name, status: "active", createdAt, updatedAt}`.

### `GET /v1/vaults` / `GET /v1/vaults/:id` — list / retrieve

### `DELETE /v1/vaults/:id` — delete (hard)

Returns `204`. Hard delete (no record retained, §12.7).

### `POST /v1/vaults/:id/archive` — archive (cascades to credentials)

`Idempotency-Key` required. Cascades: all credentials archived (secrets purged, records
retained for audit; future sessions referencing it fail; running sessions continue, §12.7).
Returns `200` with `status: "archived"`.

### `POST /v1/vaults/:id/credentials` — add credential

`Idempotency-Key` required.

`static_bearer`:
```json
{"key": "https://api.github.com", "category": "static_bearer", "token": "ghp_…"}
```
`environment_variable`:
```json
{"key": "GIT_TOKEN", "category": "environment_variable", "secretValue": "ghp_…"}
```
`mcp_oauth` (Phase 2 — refresh; Phase 1 stores without refresh):
```json
{"key": "https://mcp.example.com", "category": "mcp_oauth", "accessToken": "…", "refresh": {"method": "client_secret_basic", "tokenUrl": "…", "clientId": "…", "clientSecret": "…"}}
```
`model_provider_key` (the tenant's own model-provider API key, §4.2 — resolved host-side
at wake, fail-closed):
```json
{"key": "openai", "category": "model_provider_key", "apiKey": "sk-…"}
```

- `key`: `mcpServerUrl` for MCP creds, `secretName` for env-var creds, the Pi provider id
  (e.g. `openai`) for `model_provider_key` creds (§12.1). Immutable; to change, archive
  and create a new.
- Unique key per vault (§12.4) — `409 conflict` on duplicate.
- Max 20 credentials per vault (§12.4) — `422` over the limit.
- **Sensitive fields (`token`, `access_token`, `refresh_token`, `client_secret`,
  `secretValue`, `apiKey`) are write-only** — never returned in API responses (§12.4).

Response `201`:
```json
{"id": "vcred_01J…", "vaultId": "vault_01J…", "key": "https://api.github.com", "category": "static_bearer", "status": "active", "createdAt": "…"}
```
(Note: no `token` field in the response.)

### `GET /v1/vaults/:id/credentials` — list

Returns credential records **without** sensitive fields.

### `DELETE /v1/vaults/:id/credentials/:key` — archive a credential (purges secret, frees key)

Returns `200` with `status: "archived"`. The secret payload is purged; the key remains
visible and is freed for a replacement (§12.7).

### `POST /v1/vaults/:id/credentials/:key/validate` — validate OAuth status

Response `200`: `{"status": "valid" | "invalid" | "unknown"}` — `invalid` = grant gone /
4xx → prompt re-auth; `unknown` = transient 5xx/429/network → retry (§12.5).

---

## Memory stores

> **Spec:** §8.6, §13. Cross-session memory mounted as a volume in the sandbox.

### `POST /v1/memory-stores` — create

`Idempotency-Key` required. Body:
```json
{"displayTitle": "Project conventions", "instructions": "Follow the existing patterns…", "access": "read_write", "metadata": {}}
```
- `instructions`: ≤4096 chars (§13.2).
- `access`: `read_write` (default) | `read_only` (for untrusted input, §13.2).
- Max 8 memory stores per session (§13.2).

Response `201`: `{id: "mem_…", displayTitle, instructions, access, status: "active", mountPath: null, createdAt, updatedAt}`.
(`mountPath` is set on the session resource when attached, not here — read it, don't
construct it, §13.3.)

### `GET` / `PATCH` (description, instructions) / `DELETE` — standard

### `GET /v1/memory-stores/:id/memories` — list memories

Response `200`: `{data: [{path, contentSha256, updatedAt, …}], nextCursor}`.

### `POST /v1/memory-stores/:id/memories` — create

Body: `{path, content}`. Individual memory ≤100 kB (~25k tokens); store holds max 2,000
memories (§13.2). Creates an immutable version (`memver_…`, §13.5).

### `GET /v1/memory-stores/:id/memories/:m` — retrieve (with content)

### `PATCH /v1/memory-stores/:id/memories/:m` — update (optimistic concurrency via sha256)

Body: `{content, contentSha256?}`. The update only applies if the stored hash still
matches `contentSha256`; on mismatch → `409 conflict` (`code: conflict`) — re-read and
retry (§13.4). Creates a new version.

### `DELETE /v1/memory-stores/:id/memories/:m` — delete

### `GET /v1/memory-stores/:id/versions` — list memory versions (audit trail)

Query: `?limit=&cursor=&memoryPath=` (filter to one memory's versions).
Response `200`: `{data: [{id: "memver_…", memoryPath, contentSha256, redacted, createdAt, expiresAt}], nextCursor}`.
Versions belong to the store (not the memory) and survive memory deletion (§13.5).
Retained 30 days; recent versions always kept regardless of age.

### `GET /v1/memory-stores/:id/versions/:v` — retrieve a version

### `POST /v1/memory-stores/:id/versions/:v/redact` — redact (scrub content, keep audit)

`Idempotency-Key` required. Scrubs content out while preserving the audit trail
(who/what/when) — for compliance (§13.6). A version that is the **current head of a live
memory cannot be redacted** — `409 conflict`; write a new version first (or delete the
memory), then redact the old one.

---

## Files

> **Spec:** §8.9, §21, §16.6, §24.8. A separate Files API for uploading and managing
> files. Files are independent resources — not affected by session deletion.

### `POST /v1/files` — upload (multipart)

`Idempotency-Key` required. Multipart form: `file` + optional `metadata`, `sessionId`.
Response `201`: `{id: "file_…", name, contentType, sizeBytes, sessionId, createdAt, metadata}`.

### `GET /v1/files` — list

Query: `?limit=&cursor=&sessionId=`. Response `200`: `{data, nextCursor}`.

### `GET /v1/files/:id` — retrieve metadata

### `GET /v1/files/:id/content` — download content

Returns the raw file content with appropriate `Content-Type`.

### `DELETE /v1/files/:id` — delete

Returns `204`. Hard delete (§21).

---

## Skills

> **Spec:** §8.10, §20. Pi has a native skills system (Agent Skills standard) — used
> directly. Pre-built (`pptx`, `xlsx`, `docx`, `pdf` per decisions.md) + custom.

### `POST /v1/skills` — upload (zip or individual files; returns skill_ id)

`Idempotency-Key` required. Multipart form: `file` (zip or `SKILL.md` + supporting files),
optional `displayTitle` (derived from `SKILL.md` if omitted; must be unique among custom
skills in the tenant, §20.2). Response `201`: `{id: "skill_…", displayTitle, type: "custom", versions: [{version: 1, createdAt}], createdAt}`.

### `GET /v1/skills` — list

Query: `?limit=&cursor=&type=`. Response `200`: `{data, nextCursor}`.

### `GET /v1/skills/:id` — retrieve

### `GET /v1/skills/:id/versions` — list versions

### `DELETE /v1/skills/:id` — delete

Returns `204`.

---

## Outcomes

> **Spec:** §8.11, §16. Outcome lifecycle is event-driven; the REST surface is minimal
> (define + list). The grader is a subagent (Phase 3, §3.2).

### `POST /v1/sessions/:id/outcomes` — define an outcome

`Idempotency-Key` required. (Equivalent to sending a `user.define_outcome` event.)

Body:
```json
{
  "description": "Refactor auth.ts to use async/await",
  "rubric": {"type": "text", "content": "## Criteria\n- All callbacks converted…"},
  "maxIterations": 3
}
```
- `rubric`: `{type: 'text', content}` or `{type: 'file', fileId}` (§16.2, §16.3).
- `maxIterations`: default 3, max 20 (§16.3).
- One outcome at a time per session — `409 conflict` if one is active (§16.5).

Response `202`: `{id: "outc_…", status: "active", iteration: 0, createdAt}`.

The backend provisions a **grader** (separate `AgentSession` with its own context +
rubric, reading `/mnt/session/outputs/`, §16.1/§16.4) and runs the iteration loop:
produce → grade → feedback → repeat.

### `GET /v1/sessions/:id/outcomes` — list outcome evaluations + results

Response `200`: `{data: [{id, description, status, result, iteration, createdAt, …}], nextCursor}`.

`result` taxonomy (§16.5): `satisfied` (→ idle) | `needs_revision` (→ new iteration) |
`max_iterations_reached` (→ one final revision, then idle) | `failed` (→ idle, rubric
doesn't match) | `interrupted` (only if evaluation started before a `user.interrupt`).

### `POST /v1/sessions/:id/outcomes/:outcomeId/cancel` — cancel an active outcome

Aborts the iteration loop, persists `result: "interrupted"`, and releases the
one-at-a-time slot. Idempotent — cancelling an already-terminal outcome returns `200`.

### Deliverables

The agent writes output files to `/mnt/session/outputs/` inside the sandbox (§16.6). Once
the session is idle, fetch them via `GET /v1/sessions/:id/outputs[/:filename]` (see
Sessions) or through the Files API scoped to the session (`?sessionId=`).

---

## Scheduled Jobs (Crons)

> **Spec:** §8.7, §17, §14.4. A scheduled job starts sessions autonomously on a recurring
> cron schedule. One-shot jobs (single-fire schedule) cover the remote-delegation case.

### `POST /v1/jobs` — create

`Idempotency-Key` required.

Body:
```json
{
  "name": "nightly-test-run",
  "agent": "agent_01J…",
  "environmentId": "env_01J…",
  "initialEvents": [{"type": "user.message", "content": "Pull latest and run the full E2E suite"}],
  "sessionConfig": {"resources": [], "vaultIds": ["vault_01J…"]},
  "schedule": {"cron": "0 7 * * 1-5", "tz": "America/New_York"},
  "oneShot": false,
  "metadata": {}
}
```
- `agent`: same three forms as session creation (§6.3).
- `initialEvents`: a `user.message` event — **required** (§17.1).
- `schedule.cron`: POSIX cron, max granularity minute (§17.2).
- `schedule.tz`: IANA identifier. Literal wall-clock matching (spring-forward skip,
  fall-back double-fire, §17.2). Jitter up to 10s.
- `oneShot`: `true` for single-fire delegation jobs (§14.4, §17.8).
- Max 1,000 jobs per tenant (§17.3) — `422` over the limit.

Response `201`: `{id: "job_…", name, status: "active", …, createdAt, updatedAt}`.

### `GET /v1/jobs` / `GET /v1/jobs/:id` — list / retrieve

### `POST /v1/jobs/:id/pause` — pause

`Idempotency-Key` required. Suppresses scheduled triggers; running sessions continue;
manual `run` still allowed (§17.5). Sets `pausedReason: {"type": "manual"}`. Returns `200`.

### `POST /v1/jobs/:id/unpause` — resume

`Idempotency-Key` required. Resumes from the next scheduled occurrence. **Missed triggers
are not backfilled** (§17.5). Returns `200`.

### `POST /v1/jobs/:id/archive` — archive (terminal, immutable)

`Idempotency-Key` required. Terminal: schedule stops, job becomes immutable (§17.5). If the
job's agent has been archived, the job is auto-archived in the same operation; no run is
recorded. Returns `200` with `status: "archived"`.

### `POST /v1/jobs/:id/run` — manual trigger (works while paused)

`Idempotency-Key` required. Triggers a session immediately and writes a run marked as
manual (§17.7). Works while paused. Returns `202` with `{runId, sessionId?}`.

### `GET /v1/jobs/:id/runs` — list deployment runs

Response `200`: `{data: [{id, scheduledAt, triggeredAt, sessionId, manual, error, createdAt}], nextCursor}`.

Run `error` taxonomy (§17.4): `environment_archived`, `agent_archived`, `vault_not_found`,
`session_rate_limited`, `service_unavailable`.

#### Failure behavior (§17.6)
- `session_rate_limited`: recorded immediately, **no retry**; schedule tries again next occurrence.
- `agent_archived` / `environment_archived` / `vault_not_found`: failed run + **auto-pause**
  (`pausedReason.error.type` mirrors the run's `error.type`) so you can update and resume.

#### Exactly-once firing (§17.8)
The scheduler ticks every minute; each occurrence is claimed by `INSERT … ON CONFLICT
(job_id, scheduled_at) DO NOTHING` — a crashed/restarted scheduler or a second control-plane
node cannot double-fire. Catch-up window: default 5 min (configurable); older misses
recorded as skipped runs.

---

## Webhooks

> **Spec:** §8.8, §23, §12.7 (vault events), §17 (job events). Notify of major state
> changes without polling.

### `POST /v1/webhooks` — register endpoint

`Idempotency-Key` required.

Body:
```json
{
  "url": "https://hooks.example.com/pi-managed",
  "eventTypes": ["session.status_idle", "session.status_terminated", "job.run_failed", "vault_credential.refresh_failed"]
}
```
- `url`: HTTPS on port 443, publicly resolvable hostname (§23.3).
- Returns the `wh_…` id and the **`whsec_` signing secret shown once** (§23.3).

Response `201`:
```json
{"id": "wh_01J…", "url": "https://hooks.example.com/pi-managed", "eventTypes": […], "status": "active", "signingSecret": "whsec_…", "createdAt", "updatedAt"}
```
(`signingSecret` is returned only here; never again.)

### `GET /v1/webhooks` / `GET /v1/webhooks/:id` — list / retrieve

(Retrieve does NOT return `signingSecret`.)

### `DELETE /v1/webhooks/:id` — delete

Returns `204`.

### `POST /v1/webhooks/:id/test` — send a test event

`Idempotency-Key` required. Sends a test event to the endpoint. Returns `200` with
`{delivered: bool, responseCode?: int}`.

#### Payload shape (§23.2)
Thin payloads — event `type` and `id`, NOT the full object. On receipt, fetch the object
with a `GET`:
```json
{"type": "session.status_idle", "id": "evt_01J…", "createdAt": "2026-07-13T12:00:00Z"}
```
The top-level `event.id` is unique per event, not per delivery — duplicate `event.id` =
retry, discard it.

#### Signature verification (§23.4)
Every delivery carries `X-Webhook-Signature`. Verify; reject if invalid or payload >5 min old.

#### Delivery behavior (§23.5)
- Ordering not guaranteed — sort by `createdAt`.
- Retries: at-least-once; same `event.id`.
- Ack: any `2xx`; anything else (incl. `3xx`) fails → retry. Redirects **not** followed.
- **Auto-disable** (~20 consecutive failures, or immediately on private-IP resolution or
  redirect) with machine-readable `disabledReason`. Re-enable manually.

#### Event sources (§23.1)
`session.status_run_started`, `session.status_idle` (the legacy alias
`session.status_idled` is also accepted), `session.status_rescheduled`,
`session.status_terminated`, `session.thread_created`, `session.thread_idled`,
`session.thread_terminated`, `session.outcome_evaluation_ended`, `session.updated`,
`session.deleted`; vault/credential lifecycle (`vault.archived`, `vault.deleted`,
`vault_credential.archived`, `vault_credential.deleted`, `vault_credential.refresh_failed`);
job/run events (`job.run_failed`, `job.run_succeeded`, `job.paused`, `job.archived`).

---

## Tenant / admin (SaaS shape)

> **Spec:** §8.12, §27.3, §26.2.

### `GET /v1/tenant` — current tenant info + quota usage

Response `200`:
```json
{
  "tenantId": "tnt_01J…",
  "name": "Acme Corp",
  "quotaPlan": "pro",
  "quotaUsage": {
    "concurrentSessions": 3,
    "concurrentSandboxes": 3,
    "jobs": 42,
    "vaultSize": 5,
    "memorySize": 120000,
    "fileStorage": 5368709120,
    "tokenSpendUsd": 12.34
  },
  "quotaLimits": {
    "concurrentSessions": 10,
    "concurrentSandboxes": 10,
    "maxJobs": 100,
    "maxVaultCredentials": 100,
    "maxMemoryStores": 25,
    "maxFileStorageBytes": 10737418240,
    "monthlyTokenSpendUsd": 200
  }
}
```
`quotaLimits` is the tenant's quota plan (the tier's ceilings, `domain/quota/plans.ts`;
values shown are the `pro` defaults). Quota limits enforced at API + scheduler (§27.3);
per-tenant rollups via `metadata.userId` attribution (§26.2).

### `POST /v1/api-keys` — issue an API key (scoped to tenant)

`Idempotency-Key` required (response never stored — replay `409`s, see `Idempotency-Key`).
Body: `{name, scopes?}` — `scopes` defaults to `["read"]` (see Authorization scopes).
Returns `201`:
```json
{"id": "apikey_01J…", "name": "ci-key", "key": "pmb_live_…", "scopes": ["read"], "createdAt": "…"}
```
The raw `key` is **shown once** (stored hashed argon2id, §8). Never returned again.

### `GET /v1/api-keys` — list keys

Returns key records **without** the raw key. `404` for revoked keys in retrieve.

### `DELETE /v1/api-keys/:id` — revoke

Returns `204`. Sets `revoked_at`; the key immediately stops authenticating.

### `POST /v1/onboarding/signup` — public self-service sign-up (SaaS)

**Public/unauthenticated** (the only such route besides `/healthz`/`/readyz`), gated by
`ONBOARDING_ENABLED` — `403 forbidden` when disabled (the self-hosted default). First
sign-up creates a tenant + admin API key (shown once) and returns the `pi install`
command, backend URL, and extension config (§29.6, §24.3). Returns `201`. A repeat
sign-up for an existing `adminEmail` reuses the tenant and **omits `apiKey`** (no
credential re-issuance to an unauthenticated caller); the response shape is otherwise
identical, so it never leaks which admin emails already exist.

### Read-only web console

A read-only web console (session list, tracing view, usage) is served same-origin at
`/console` (§26.6). Static assets load without a key; its `/v1/*` calls authenticate with
an API key entered in the UI.

---

## Self-hosted work queue

> **Spec:** §10.4, §8.2 (`work-stats`). Implemented (WP-4.1).

Management routes (org API key):

- `GET /v1/environments/:id/work-stats` → `200`
  `{depth, pending, oldestQueuedAt, workersPolling}` (§10.4) — for liveness alerting.
- `POST /v1/environments/:id/work-stop` → `{force?: boolean}`. Asks the worker handling a
  session to shut it down cleanly; `force: true` interrupts immediately. Auths with the org
  API key (not the worker key); docs warn against setting the org key on the worker
  host (§10.4).
- `POST /v1/environments/:id/worker-keys` — issue an environment-scoped worker key
  (`self_hosted_worker:<envId>` scope, valid only for the worker routes below). Org-key
  auth. Returns `201`; the secret is shown once.

Worker routes (worker key):

- `POST /v1/environments/:id/work-claim` — claim the next queued work item
  (`FOR UPDATE SKIP LOCKED`). `200` with the item, or `204` when the queue is empty.
- `POST /v1/sessions/:id/work-result` — post the executed tool's result; recorded as a
  `user.tool_result` event (§9.2). Returns `200`.

Notes:

- Worker patterns (§10.4): always-on (polls the queue; outbound HTTPS only) or
  webhook-triggered (wakes on `session.status_run_started`). The backend ships a default
  worker (Node, `packages/worker`) with two control levels.
- Unsupported-features matrix for self-hosted (§10.4/§13.7): **no memory stores, no
  env-var credentials** — enforced with clear `422` errors at session creation. The
  subscriber stages files/repos themselves (passed via session `metadata`).
