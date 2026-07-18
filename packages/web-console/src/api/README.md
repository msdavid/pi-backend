# `src/api/` — typed API client (WP-C1.5)

The console's one path to the backend: same-origin `fetch` over the public
`/v1` API plus the console-support endpoints (`/console/config`,
`/console/session`) and the two public health probes (`/healthz`, `/readyz`
— the solo/team Settings widget, console-spec §5.1). Nothing else,
enforced by the phase-1 endpoint-allowlist gate (§1.2).

## Architecture

```
client.ts       fetch wrapper: ConsoleApiClient + ConsoleApiError + apiClient
                (+ ConsoleApi, the structural surface hooks depend on)
provider.tsx    ApiClientProvider / useApiClient — the injection seam for
                UI tests (defaults to the app-wide apiClient)
pagination.ts   cursor-pagination helpers (api-reference §"Cursor pagination")
keys.ts         query-key factories, one per resource family
console.ts      /console/config + /console/session  — fetchers + hooks
sessions.ts     /v1/sessions (+ detail/entries/usage/tree/outputs, fork) —
                fetchers + hooks (tree/outputs/fork, WP-C2.3; the
                ?stopReason= filter + useRequiresActionSessions, WP-C2.2)
session-events.ts POST /v1/sessions/:id/events — the W4 inbound events
                (user.message / user.interrupt / user.tool_confirmation),
                WP-C2.2 (same family as sessions.ts, split for file size)
session-stream.ts useSessionStream / applyStreamFrame — the WP-C2.1 live
                stream folded into the Query caches (same family as
                sessions.ts, split for file size)
conversation.ts GET /v1/sessions/:id/messages — the WP-C4.1 Conversation
                lens seed (Pi's post-compaction session.messages view;
                same family as sessions.ts — see the module header for
                the honest freshness/latency contract)
stream.ts       SSE transport for GET /v1/sessions/:id/stream (fetch
                streaming, reconnect/replay, polling fallback)
jobs.ts         /v1/jobs (+ detail/runs, manual trigger — WP-C2.4;
                create/pause/unpause/archive — WP-C3.5)
memory-stores.ts /v1/memory-stores (+ memories/content, versions — WP-C2.4;
                version restore [server-side copy into a NEW head
                version] — WP-C4.0b)
agents.ts       /v1/agents (+ versions, create/PATCH/archive — PATCH creates
                version n+1, archive terminal) — WP-C3.1
environments.ts /v1/environments (+ create/PATCH/archive/DELETE,
                worker-key mint [show-once], work-stats [polled while
                visible], work-stop [force = second step]) — WP-C3.2
vaults.ts       /v1/vaults (+ credentials add/archive/validate;
                secret fields write-only; an archived credential keeps
                its key reserved — see module header) — WP-C3.3
api-keys.ts     /v1/api-keys (list/issue/revoke; raw key shown once;
                workerKeyScopeOf splits worker keys out) — WP-C3.4
webhooks.ts     /v1/webhooks (+ register/delete/test; whsec_ shown once;
                NO enable/disable endpoint exists — see module header)
                — WP-C3.4
onboarding.ts   POST /v1/onboarding/signup (public; key shown once) +
                the W8 first-run progress probe (composes vaults/agents/
                sessions reads; checklist-local query key)
files-skills.ts /v1/files + /v1/skills read surfaces + DELETE (uploads are
                multipart and deliberately not modeled) — WP-C3.6
tenant.ts       /v1/tenant (+ /usage — the WP-C3.0 time-bucketed series)
                — consumed by the WP-C3.6 tenant dashboard
billing.ts      /v1/tenant/billing family (saas commercialization, §11) —
                WP-C5.4. LEDGER tier (always real): balance/lifecycle/
                verification, ledger history, resend, verify-email. ADAPTER
                tier (served only by a billing-adapter proxy; 404 ⇒ the
                no-adapter state, §11.8): auto-charge get/update + checkout/
                portal link-out. getAutoCharge maps 404 → null (the single
                adapter-presence signal). No money is computed client-side
                (§11.9) — the runway day-count (`lib/runway.ts`) is the one
                derived figure and yields days, not dollars
health.ts       /healthz + /readyz probes (C§5.1, solo/team widget) — its
                OWN fetch transport: /readyz answers 503 WITH a readable
                per-check body, which the throw-on-non-2xx JSON client
                cannot surface. Tests inject via the HealthProber
                capability (the SessionStreamer duck-typing pattern);
                query keys live in-module (non-/v1 family) — WP-C3.6
__tests__/      contract tests against the REAL in-process backend
```

- **Transport** (`client.ts`): always the real global `fetch`,
  `credentials: "same-origin"` (auth is the HttpOnly console-session cookie,
  console-spec §4.3 — never a key in JS). Every mutating method carries
  `X-Console-Csrf: 1` (§4.5); mutating `POST`s auto-generate an
  `Idempotency-Key`. Non-2xx responses are parsed from the single wire error
  envelope into `ConsoleApiError` carrying `status` / `code` / `message` /
  `requestId` — the DP-9 rendering data. (`requestId` comes from the envelope
  body; the backend sets no request-id response header.) Tests may pass
  `baseUrl` + extra `headers` (`Cookie`, `Authorization`) at construction —
  an init override, never a transport fake.
- **Validation at the seam** (C§12.3): `get`/`post` take an
  `@pi-managed/contracts` zod schema and validate the response body. A body
  the schema rejects surfaces as a `ConsoleApiError` (client/server
  mismatch).
- **Pagination** (`pagination.ts`): `withQuery` builds
  `?limit=&cursor=&<filters>`; `cursorPageParams` spreads into
  `infiniteQueryOptions` (`nextCursor: null` ⇒ end of set; the cursor is
  opaque and passed back verbatim).
- **Query layer**: each family module exports plain fetchers
  (`(args, client = apiClient)`), `queryOptions` factories, and thin
  `use*` hooks that read the client from `useApiClient()` (the app-wide
  `apiClient` unless a test overrode it). Later WPs add one module per
  family, 1:1 with `contracts/src` (same rule as `src/features/`).
- **UI-test seam** (`provider.tsx`, WP-C1.6): for UI components the client is
  a COLLABORATOR (CONVENTIONS.md "Fakes at the seam"), so component tests
  wrap trees in `<ApiClientProvider api={fake}>` with a `ConsoleApi` fake
  (`src/test/fake-console-api.ts`) instead of ever stubbing `fetch`. The
  client itself stays the subject only in `__tests__/`, against the real
  backend.

## Live streaming (`stream.ts` + `session-stream.ts`, WP-C2.1)

Live views consume `GET /v1/sessions/:id/stream` with **fetch streaming, not
`EventSource`** (console-spec §8.1 — control over headers, reconnect, and the
replay position). Same-origin and cookie-authed like every other request; no
CSRF header (it is a read).

- **Transport** (`stream.ts`, `streamSessionEvents`): parses SSE frames
  (`id`/`event`/multi-line `data`), tracks the last seen `id` (the event's
  projection position — live and replayed frames carry the same one), and on
  a dropped connection reconnects with exponential backoff sending
  `Last-Event-ID`, so the replay resumes gap-free (api-reference §"Reconnect
  & replay"): nothing missed, nothing duplicated. Without a `Last-Event-ID`
  the server replays the full history from position 0. After
  `DEFAULT_MAX_CONNECT_FAILURES` consecutive failed connects it degrades to
  polling `GET …/entries` (mirroring the client-extension, §24.10) — entry
  `seq` is the same position ladder as the SSE `id`, so polled entries
  continue the cursor seamlessly. A clean server close (no active runtime to
  tail) ends the stream — UNLESS `shouldReconnectOnClose` reports the session
  is still non-terminal: the backend serves an idle session with no live
  runtime a history-only stream that closes right after replay, and a later
  `user.message` (this browser's composer OR a CLI `/remote:resume`) wakes a
  runtime whose events only appear on a *fresh* connection, so the transport
  reconnects at a modest `idleReconnectMs` cadence (Last-Event-ID keeps it
  gap-free; the sleep keeps it off a busy-loop) to observe the cold wake
  instead of latching `ended` (F1). Aborting the caller's `AbortSignal` stops
  everything and resolves the promise.
- **Query-cache integration** (`session-stream.ts`; §8.2 — no parallel
  store): `useSessionStream(sessionId, {enabled})` folds every frame into
  the existing caches via `applyStreamFrame` — entries pages are patched by
  `seq` (upsert, dedupe against the already-fetched slice),
  `session.status_*` frames invalidate the session detail + usage queries,
  the list queries (status/stopReason drive the list rows and the §7.5
  requires_action badge, WP-C2.2), and the conversation messages query
  (WP-C4.1 — the JSONL behind `/messages` is synced on every status_idle
  transition, so the refetch lands the finished turn), and a
  `session.stream_lagged` notice
  invalidates the entries queries so the refetch closes the gap. Frames
  arriving while the initial entries query is still in flight are buffered
  and flushed through the same seq-dedupe upsert the moment the query
  resolves (§8.1 no-missed-events: patching an empty cache would silently
  drop them). The stream starts from the highest cached `seq`, so a trace
  the Trace tab already fetched is not replayed. The hook is mounted ONCE
  per viewed session by the session-detail page — not by the Trace tab,
  which unmounts on tab switches while §8.3's ambient title/favicon still
  needs the detail cache fresh — and disabled once the session is terminal
  (`isTerminalSessionStatus`). It supplies the transport's
  `shouldReconnectOnClose` predicate off the cached detail status, so a clean
  close reconnects at the idle cadence while the session can still wake and
  only latches `ended` once it is terminal (F1 — cold-wake observability).
  The hook's `phase` (`connecting` / `live` / `polling` / `ended`) is passed
  to the Trace tab, driving its indicator and its polite ARIA live region
  (C§12.2).
- **UI-test seam**: an injected client that implements the optional
  `SessionStreamer` capability (`streamSession`) supplies the transport —
  `FakeConsoleApi` does, with `emitStream`/`endStream`/`streamPhase`
  scripting. The production `ConsoleApiClient` does not, so the app uses the
  real `streamSessionEvents`. The transport itself is tested against real
  servers only: `stream.test.ts` (scripted local `http` server) and
  `__tests__/stream.contract.test.ts` (the real backend; see below).

## Query-key conventions (`keys.ts`)

Hierarchical arrays so invalidation targets any level:

```
["console", "config"]                          consoleKeys.config()
["console", "session"]                         consoleKeys.session()
["sessions", "list", {filters}]                sessionKeys.list(filters)
["sessions", "detail", id]                     sessionKeys.detail(id)
["sessions", "detail", id, "entries", {params}]  sessionKeys.entries(id, params)
["sessions", "detail", id, "usage"]            sessionKeys.usage(id)
["sessions", "detail", id, "tree"]             sessionKeys.tree(id)
["sessions", "detail", id, "outputs"]          sessionKeys.outputs(id)
["sessions", "detail", id, "messages"]         sessionKeys.messages(id)
["jobs", "list", {filters}]                    jobKeys.list(filters)
["jobs", "detail", id]                         jobKeys.detail(id)
["jobs", "detail", id, "runs", {params}]       jobKeys.runs(id, params)
["memory-stores", "list", {params}]            memoryStoreKeys.list(params)
["memory-stores", "detail", id]                memoryStoreKeys.detail(id)
["memory-stores", "detail", id, "memories"|"memory"|"versions"|"version", …]
["agents", "list"|"detail", …]                 agentKeys (+ versions/version)
["environments", "list"|"detail", …]           environmentKeys (+ work-stats)
["vaults", "list"|"detail", …]                 vaultKeys (+ credentials)
["api-keys", "list", {}]                       apiKeyKeys.list()
["webhooks", "list"|"detail", …]               webhookKeys
["files", "list"|"detail", …]                  fileKeys
["skills", "list"|"detail", …]                 skillKeys (+ versions)
["tenant", "info"|"usage", …]                  tenantKeys
["health", "healthz"|"readyz"]                 healthKeys (local to health.ts)
```

A successful manual job trigger invalidates `jobKeys.detail(id)` — the
subtree containing every runs page — so the new run shows up. A successful
fork seeds the new session into its detail cache (the success notice links
straight to it) and invalidates the session list queries.

## Inbound session events (`session-events.ts`, WP-C2.2)

`sendSessionEvent` / `useSendSessionEvent` post the three W4 events —
`user.message` (steer; idle-only, `409 session_not_idle` mid-turn),
`user.interrupt`, and `user.tool_confirmation` (`allow`/`deny` per blocking
event id, §9.5) — to `POST /v1/sessions/:id/events`. Every accepted event
answers `202 {accepted: true}`; the mutation invalidates the session's
detail subtree plus the list queries so the UI converges even without a
stream, and an open stream's `session.status_*` frames deliver the same
invalidations the moment the session reacts.

The §7.5 global surfaces (sidebar badge + Home section) share
`useRequiresActionSessions`: ONE first-page query over the server-side
`?stopReason=requires_action` filter (WP-C2.0), polled every 30 s
(`REQUIRES_ACTION_REFRESH_MS` — a human-attention-span refresh costing one
single-page read; stream invalidations keep it immediate while any session
detail is streaming). `hasNextPage` marks the count as "N+" (truncation
honesty).

Sign-in invalidates `consoleKeys.session()`; sign-out resets the whole cache
(it all belonged to the signed-out key) — `resetQueries`, not `clear`, so the
active session query refetches and the app lands back on sign-in.

## Contract tests (`__tests__/`)

Seam rule (CONVENTIONS.md): the client↔server boundary is the subject, so
both sides are real — `harness.ts` boots Postgres via
`@testcontainers/postgresql` (podman/docker socket auto-detected), runs the
real migrations, builds the real Fastify app from `@pi-managed/backend`, and
listens on an ephemeral port; the client talks to it with the real global
`fetch`. Nothing is stubbed or `fetchImpl`-injected.

```sh
PI_REQUIRE_INTEGRATION=containers pnpm --filter @pi-managed/web-console test -- src/api
```

`PI_REQUIRE_INTEGRATION=containers` makes a missing container runtime a hard
failure instead of a silent skip (same policy as the backend suites).

The scripted session-manager / sandbox stand-ins these suites wire through
the backend's `CreateAppOptions` seams live in `collaborators.ts` (shared
with the phase-2 gate in `test/phase2-gate/` — collaborators, not transport
fakes: every suite still crosses the real routes and the real wire).

- `contract.test.ts` — config endpoint, bearer-authed reads, cursor
  pagination, error-envelope parsing on real 401/404 responses, CSRF +
  idempotency header presence (asserted via a server-side echo route).
- `console-session.contract.test.ts` — the §4 cookie flow (sign-in cookie,
  cookie-only `/v1` reads, CSRF enforcement, sign-out). Runs unconditionally
  (un-skipped by WP-C1.8; the phase-1 gate in `test/phase1-gate/` enforces
  the same invariants at release time).
- `stream.contract.test.ts` — the §13 item 8.1 acceptance (WP-C2.1):
  cookie-authed replay + clean end, connection killed mid-stream →
  `Last-Event-ID` resume with no missed/duplicated entries (including an
  event emitted while disconnected), and the polling fallback against a
  backend without the stream route, with JSONL-backed entries advancing.
  The events surface is wired through `startTestBackend({app: …})` — the
  same `CreateAppOptions` seams the composition root uses.
- `sessions-fork.contract.test.ts` — the WP-C2.3 surface: the W6 fork
  round-trip (fork through the real app; the new session exists for
  cookie-authed reads with `forkedFromSessionId` set, and its tree serves
  the same JSONL branches as the parent — Pi-native tree fork), tree reads
  (empty + JSONL-seeded via a real `FilesystemObjectStore`), the outputs
  listing plus the download route fetched with only the console-session
  cookie (what the Outputs tab's `<a href>` rides), and the idle-only
  `409 session_not_idle`. The outputs routes mount through the same
  `CreateAppOptions` sandbox seams the composition root uses, with a
  scripted `SandboxProvider` collaborator.
- `session-messages.contract.test.ts` — the WP-C4.1 seed (§10.1): the
  `listSessionMessages` fetcher over the cookie wire — empty for a fresh
  session (no log), exactly the message-bearing JSONL entries in log order
  for a seeded log (real `FilesystemObjectStore`), and the forked-session
  seed boundary (the fork's `/messages` serves the history shared with its
  parent — the claim the Conversation tab's fork microcopy makes).
- `session-wake.contract.test.ts` — the WP-C4.2 wake contract (§10.1, W5):
  a freshly seeded (idle) session, `user.message` through the composer's
  client path (cookie + CSRF + auto `Idempotency-Key`) → `202`, the
  route's ADVANCE resolver invoked (the seam that in production is
  `sessionManager.getOrCreate` → `wake()` → sandbox provision), the
  message + `session.status_run_started` transition observed on the
  already-open stream, and the follow-up `user.message` accepted at the
  next turn boundary (the composer's client-side queue flush). The real
  sandbox provision + model turn inside the production resolver are not
  exercisable in the harness (no sandbox host, no provider key) — the test
  header documents the boundary; the mid-turn `409` the queue exists for
  is in `session-events.contract.test.ts`. The boundary itself is closed by
  the `@kvm` phase-4 gate (`test/phase4-gate/continue-anywhere.gate.test.ts`,
  WP-C4.3): the full `createManagedApp` composition with the REAL
  `MicrosandboxProvider` — a real cold wake on a microVM, requires_action
  through the real permission gate, interrupt, and the synced-JSONL
  hand-back state (only the model brain is a scripted collaborator).
- `session-events.contract.test.ts` — the WP-C2.2 acceptance (W4): a
  session seeded idle on `stopReason: requires_action` (row update via
  `tenantScopedQuery`, the WP-C2.0 seeding shape), the cookie-authed
  `user.tool_confirmation` post (`202 {accepted: true}`), and the resulting
  transition observed on the ALREADY-OPEN SSE stream (confirmation +
  `session.status_run_started` continue the position ladder gap-free) with
  the detail read agreeing; the `?stopReason=` filter + `usage.usdCost`
  rollup over the cookie wire; `user.message` idle-only (`409`),
  `user.interrupt` accepted while running; `403` for a `read`-scoped cookie.
  The events surface mounts through the same `CreateAppOptions` seams as
  `stream.contract.test.ts`, with a scripted session-manager collaborator
  that mirrors §9.5 (persist the confirmation, return the session to
  `running`, emit the status event).
- `admin-families.contract.test.ts` — the WP-C3-prep client modules' READ
  paths (mutation depth arrives with the C3.x feature WPs): agents
  list/detail/versions, environments list/detail + self-hosted `work-stats`,
  vaults + credential records (asserting NO sensitive field on the wire —
  C§13 §9.3), api-keys list (no raw key), webhooks register→list/retrieve
  (signing secret only on create), files (seeded via the real multipart
  route) + skills, and `GET /v1/tenant[/usage]` (quotaLimits round-trip).
- `agents-lifecycle.contract.test.ts` — the WP-C3.1 write lifecycle: create →
  PATCH (immutable version bump; omitted fields keep their value) → archive
  (terminal, idempotent, still readable; PATCH then `409 resource_archived`),
  422 from the shared contracts schema, and `403` for a `read`-scoped create
  (§6.2 — the backend enforces).
- `settings-mutations.contract.test.ts` — the WP-C3.4 mutation paths:
  api-key issue defaults to `["read"]` (opt-up), issue → authenticate →
  revoke → `401` round-trip (the raw key only ever in the create response;
  the record survives with `revokedAt` for the list's terminal state), and
  webhook register (`whsec_` only on create) → test-delivery against a
  guaranteed-unresolvable `.invalid` endpoint (honest
  `{delivered: false}`) → delete → `404`.
- `vaults.contract.test.ts` — the WP-C3.3 vault mutations: create vault, add
  credential per category (raw-wire assertion that no secret field ever
  comes back — C§13), `409` on a duplicate key, deterministic §12.5
  validate outcomes with zero external network (`environment_variable` →
  `unknown`; `static_bearer` probing the harness's own `/healthz` → `valid`
  and an authed route with a garbage bearer → `invalid`), archive
  credential (secret purged; the key STAYS reserved — the `(vault_id, key)`
  unique index includes archived rows, a doc gap vs api-reference §12.7
  flagged for a backend-lane WP), archive-vault cascade, and hard delete →
  `404` with DP-9 error facts.
- `environments.contract.test.ts` — the WP-C3.2 mutation paths: environment
  create → PATCH (not versioned) → archive → hard delete → `404`; the W12
  worker surface — worker-key mint (`201` show-once shape; the `/v1/api-keys`
  RECORD carries only the `self_hosted_worker:<envId>` scope marker, never
  the raw key), `work-stats` over a genuinely seeded queue (session via the
  API + the backend's exported `enqueue` — no real worker needed) and
  `work-stop` clean → force round-trip, `422` without `sessionId`, `422`
  for `work-stats` on a `cloud` environment, `403` mint under `read`.
- `jobs-lifecycle.contract.test.ts` — the WP-C3.5 lifecycle fetchers:
  create → pause → unpause → archive round-trip (incl. `pausedReason`
  set/clear and archive idempotency + immutability), `oneShot` echo,
  server-side schedule validation (`422` on bad cron/tz — the client-side
  checks in `features/jobs/schedule.ts` are feedback only), and a real
  `403` for a read-scoped create.
- `tenant-files-skills.contract.test.ts` — the WP-C3.6 surfaces: the
  usage-over-time series with SEEDED spend (rows through the production
  `PgUsageRecorder` with `recorded_at` pinned, the WP-C3.0 backend suite's
  pattern) asserting UTC day/month buckets and both `groupBy` breakdowns
  (`agent`; `user` incl. the `null` unattributed rows); files read + the
  exact `<a href>` content-download URL answering the bytes + hard delete →
  DP-9 404; skills read/versions (`{data}`, no cursor) + hard delete; and
  the C§5.1 health prober against the real `/healthz` + `/readyz` (both
  readyz outcomes readable — the 503 body is why the transport exists).
- `onboarding.contract.test.ts` — the WP-C3.7 public surface against a
  backend booted with `ONBOARDING_ENABLED`: `/console/config` deriving
  saas + onboarding, public signup issuing the admin key exactly once
  (repeat sign-up reuses the tenant and OMITS the key, R0.3), the issued
  key signing in through the real console-session flow, and
  `fetchFirstRunProgress` flipping as the real W8 steps complete (DP-12).
- `jobs-memory.contract.test.ts` — the WP-C2.4 client modules: jobs list
  pagination + server-side `?status=` narrowing, `pausedReason` wire shape,
  manual trigger (`202 {runId, sessionId?}` and the run listed as manual),
  memory stores list/detail, memory content (incl. a `/`-containing path
  riding percent-encoded), version audit trail with the `?memoryPath=`
  filter, the WP-C4.0b version restore (round-trip content equality via
  the memories read path; `409 conflict` on a redacted source), and DP-9
  error facts on real 404s. Seeds through the API; the memory content
  store is a real `FilesystemObjectStore` passed via
  `startTestBackend({app: …})`.
- `billing.contract.test.ts` — the WP-C5.4 billing seam, two real backend
  shapes. Against the DEFAULT (billing-disabled, no adapter) backend — also the
  shipped shape until a deployment enrols a tenant + fronts the payment adapter —
  it pins the §11.8 degradation paths: `getBilling` → `404` "no billing";
  `getAutoCharge` → `null` "no adapter" (route absent); a well-formed empty
  ledger page; the write-scoped resend `202 {sent:false}` no-op; and verify-email
  rejecting an unknown token. Against an ADAPTER-CONFIGURED backend
  (`BILLING_ADAPTER_URL` + `BILLING_PROVISION_TOKEN`, via
  `startTestBackend({configEnv: …})`) it drives the WITH-adapter fetchers end to
  end through the REAL link-out proxy pointed at a fake adapter HTTP server:
  `getAutoCharge` non-null, the `updateAutoCharge` USD→config round-trip,
  `createCheckout` URL issuance + the amount-required `422`, and `createPortal`
  URL issuance. Only the payment engine (Stripe) is faked — at the adapter's own
  seam — so both sides of the console↔backend proxy are real.
