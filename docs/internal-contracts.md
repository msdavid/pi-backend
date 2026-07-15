# Internal Contracts (Seam Interfaces)

> The TypeScript definitions live in `packages/backend/src/domain/ports.ts`; the fakes
> in `packages/testkit/src/` (one file per port, barrel `index.ts` with
> `createTestKit()`). This document is the reviewer-facing map: each port's
> responsibility, the spec §s it implements, and which Phase-1 work packages consume it.

## Purpose

These ports decouple the backend's subsystems so Phase-1 work packages can build against
fakes (`@pi-managed/testkit`) in parallel before the real implementations land
(plan §4 dependency graph, §5 WP-0.10). Every Phase-1 package that touches one of these
subsystems programs to the interface and is tested against the fake; the real
implementation is swapped in later with a fake/real parity contract test
(plan §12 "Fake/real parity").

## The §25.5 invariant (load-bearing)

Spec §25.5 names three trust boundaries; the **harness (backend + `AgentSession`) cannot
see credentials**, and the sandbox cannot either. These interfaces enforce that
structurally:

- `SecretStore.resolveBindingsForSession` returns only **opaque `SecretBinding` refs**
  (a placeholder name like `$MSB_GIT_TOKEN` + a `SecretCredentialRef`). It never returns a
  secret value. There is no field on `SecretBinding` that holds a value.
- `SandboxProvider.provision` / `registerSecretBinding` accept only those opaque refs; the
  **provider implementation** resolves the value host-side (writes it into microsandbox's
  host-side secret store). The harness code that constructs a `ProvisionSpec` never
  handles a raw secret.
- `ProvisionSpec.env` is for **non-secret** literal env vars only; JSDoc on the field and
  on `ProvisionSpec` states credentials MUST go through `secretBindings`.
- **The sole deliberate exception:** `ProviderKeyResolver.resolveProviderKeys` returns raw
  model-provider API keys (§4.2). This does not break §25.5: those keys are decrypted
  host-side into the per-session in-memory `AuthStorage` only so the harness can make the
  model call — they are never registered as sandbox bindings and never visible to the
  guest.

Self-check (run after changes): `grep -nE ':\s*string' packages/backend/src/domain/ports.ts`
and confirm no method on `SecretStore` or `SandboxProvider` returns or accepts a raw secret
string. The only `string` returns on those interfaces are opaque IDs, placeholder names,
and `credentialKey`/`mcpServerUrl` locators — none of which is a secret value.
(`ProviderKeyResolver` is explicitly excluded from this check — see the exception above.)

## Ports

### `SandboxProvider` — the "Sandbox" abstraction

- **File:** `packages/backend/src/domain/ports.ts`
- **Spec:** §5.3, §5.4 (`provision`), §10.1 (provisioning), §10.2 (exec/execStream), §10.3
  (stop/start/snapshot/destroy, crash detection), §10.5 (network policy), §27.2
  (tenant-namespaced names + labels), §12/§25.1 (secret bindings as `$MSB_` placeholders).
- **Methods:** `provision`, `exec`, `execStream`, `stop`, `start`, `snapshot`, `destroy`,
  `reattachByLabels`, `status` (incl. `crashed`), `registerSecretBinding`, `metrics?`
  (optional; live per-VM resource sample, §26.4, backs `GET /v1/sessions/:id/metrics` —
  absent on providers that front no VM, e.g. self-hosted).
- **Network policy:** `NetworkPolicy = {mode:'unrestricted'} | {mode:'limited', allowedHosts}`.
  `unrestricted` compiles to microsandbox's `publicOnly()` preset (public internet allowed;
  private/loopback/link-local/cloud-metadata/**host** denied — **not** `allowAll()`).
  `limited` compiles to a default-deny `NetworkPolicy.builder()` plus explicit
  `allowHost()` rules (§6.2, Appendix A.1 #3).
- **§25.5:** `ProvisionSpec.secretBindings` carry only placeholder names + credential refs
  — never values. `registerSecretBinding` likewise.
- **Consumers:** WP-1.3 (real impl, NAPI SDK), WP-1.4 (Operations adapter delegates
  `exec`/`execStream`), WP-1.5 (session manager drives lifecycle), WP-1.2 (compile env →
  `ProvisionSpec`).
- **Fake:** `FakeSandboxProvider` — in-memory handles, `setNextStatus` for crash
  simulation, `scriptExec` for scripted output, `registeredBindings` for the §25.5 audit,
  `scriptMetrics` for the §26.4 metrics sample.

### `SessionRuntime` — the "Harness" abstraction

- **File:** `packages/backend/src/domain/ports.ts`
- **Spec:** §5.2 (`AgentSession`), §5.4 (`wake`, `getEntries`, `emitEntry`),
  §6.3 (state machine), §9 (events).
- **Methods:** `wake(sessionId)`, `sendEvent(InboundEvent)`, `subscribe()` (async iterable
  of `OutboundEvent`), `interrupt()`, `getEntries(range?)`, `status()`.
- **Pi mapping:** wraps `createAgentSession` / `AgentSession` / `SessionManager` (Pi
  `docs/sdk.md`): `wake` ≈ `createAgentSession({ sessionManager: open(jsonl) })`,
  `sendEvent` ≈ `prompt`/`steer`/`followUp` + custom-tool/confirmation flows (§9.4/9.5),
  `subscribe` ≈ `session.subscribe()`, `interrupt` ≈ `abort()`,
  `getEntries` ≈ `SessionManager.getEntries()` (positional slice). It does NOT
  reimplement Pi internals.
- **State machine:** `idle → running → rescheduling → terminated` (§6.3; 3 retries per
  `docs/decisions.md` item 7).
- **Consumers:** WP-1.5 (impl), WP-1.6 (sessions API calls runtime), WP-1.7 (events API +
  SSE maps `subscribe` → wire), WP-1.8 (toolset config materializes into the session).
- **Fake:** `FakeSessionRuntime` — scripted outbound events, seeded entries, call recording.

### `SecretStore`

- **File:** `packages/backend/src/domain/ports.ts`
- **Spec:** §12 (vaults, secret bindings), §12.5 (re-resolution), §25.1 (tokens never
  reach sandbox), §25.4 (egress substitution), §25.3 (MCP creds resolved by the proxy,
  not here).
- **Methods:** `resolveBindingsForSession(ctx) → SecretBinding[]`,
  `revalidate(ctx) → void`.
- **§25.5:** returns only opaque `SecretBinding` refs. MCP creds (`static_bearer`/
  `mcp_oauth`) become refs the backend MCP proxy injects at request time (§25.3);
  `environment_variable` creds become `$MSB_` placeholder bindings; `git_token` creds
  become host-scoped `$MSB_GIT_TOKEN_<slug>` placeholder bindings (§25.2). Callers MUST
  NOT log binding contents.
- **Consumers:** WP-1.9 (impl), WP-1.5 (session manager calls `resolveBindingsForSession`
  and hands the refs to `SandboxProvider`), WP-2.4 (refresh/re-resolution).
- **Fake:** `FakeSecretStore` — scripted refs per session; holds no values.

### `ProviderKeyResolver`

- **File:** `packages/backend/src/domain/ports.ts`
- **Spec:** §4.2 (per-session provider auth), R2.7 (fail-closed).
- **Methods:** `resolveProviderKeys(ctx) → Record<providerId → apiKey>`.
- **Distinct from `SecretStore`:** returns the tenant's OWN model-provider keys (e.g. an
  `sk-…` API key), decrypted host-side into the per-session in-memory `AuthStorage`.
  This is the sole port that hands the harness a raw credential (see the §25.5 exception
  above): the keys are NEVER registered as sandbox bindings and NEVER exposed to the
  guest — the harness holds them only to make the model call.
- **Fail-closed:** an unresolved provider key aborts the session before any model call is
  made, so it can never fall through to a provider key in the host's own environment
  (§4.2/R2.7).
- **Impl:** `createProviderKeyResolver` (`domain/vault/provider-keys.ts`), wired in the
  composition root (`app.ts`) and the session-worker entry. No testkit fake.

### `ObjectStore`

- **File:** `packages/backend/src/domain/ports.ts`
- **Spec:** §28 (persistence), §21 (files), §13 (memory store contents).
- **Methods:** `put` (streaming), `get` (streaming), `conditionalPut` (etag-based, for
  JSONL sync), `delete`, `hardDelete` (purge all versions, §13.6 redaction), `head`
  (single-object metadata, O(1), JSONL-sync etag recovery), `list` (async iterable),
  `readonly versioningSupported`.
- **Consumers:** WP-P0.3 (impl: local fs + S3-compatible), WP-1.5 (JSONL sync), WP-1.12
  (files API), WP-2.2 (memory stores), WP-1.3 (snapshots).
- **Fake:** `FakeObjectStore` — Map-backed, conditional put enforces etag match.

### `UsageRecorder`

- **File:** `packages/backend/src/domain/ports.ts`
- **Spec:** §9.7 (usage tracking), §6.3 (`budget_exhausted` stop), §26.2 (cost accounting),
  §8.12 (per-tenant rollup).
- **Methods:** `record(sessionId, model, tokens)`, `usdCost(model, tokens)`,
  `cumulativeForSession(sessionId)`, `checkBudget(sessionId, budget)`,
  `rollupForTenant(tenantId, range?)`.
- **Token shape:** `inputTokens`, `outputTokens`, `cacheCreationInputTokens`,
  `cacheReadInputTokens` — recorded exactly as each provider reports them; cache TTL and
  pricing are provider-dependent (§9.7). USD via a per-model price table (config).
- **Consumers:** WP-1.10 (impl), WP-1.5 (budget enforcement hook), WP-1.6 (sessions API
  exposes usage), WP-P0.4/§8.12 (tenant rollup).
- **Fake:** `FakeUsageRecorder` — scriptable `priceTable`, `setBudgetBreached` for the
  `budget_exhausted` stop, fallback pricing for unknown models.

### `Clock` / `Scheduler`

- **File:** `packages/backend/src/domain/ports.ts`
- **Spec:** §17.8 (scheduler impl), §17.2 (literal wall-clock / DST semantics).
- **Methods:** `Clock.now()`, `Scheduler.tick()`.
- **Why injectable:** the cron loop's wall-clock semantics are literal (spring-forward
  skip, fall-back double-fire), and exactly-once is enforced in Postgres (`(job_id,
  scheduled_at)` unique), not in the loop. `Clock` is injectable so DST/double-fire tests
  run deterministically without waiting.
- **Consumers:** WP-2.1 (scheduler impl), WP-2.5 (webhook dispatcher retry loop can reuse
  `Clock`), any subsystem that reads wall-clock time.
- **Fake:** `FakeClock` (`advance`, `set`), `FakeScheduler` (`setDue`, `onTickRun`).

### `WebhookSink`

- **File:** `packages/backend/src/domain/ports.ts`
- **Spec:** §23 (webhooks), §23.2 (thin payload).
- **Methods:** `dispatch(WebhookEvent)`.
- **Shape:** `WebhookEvent = {type, id, createdAt}` — thin payload only; recipients fetch
  the full object on receipt. `event.id` is unique per event, not per delivery.
- **Scope:** this is the **enqueue** seam. The real dispatcher (retries,
  `X-Webhook-Signature`, auto-disable, persisted queue) lands in Phase 2 (WP-2.5).
  Phase-1 subsystems emit lifecycle events through the sink without depending on the
  dispatcher.
- **Consumers:** WP-1.5/1.6/1.7 (session lifecycle events), WP-1.9 (vault events), WP-2.5
  (real dispatcher consumes the queue), WP-2.1 (job/run events).
- **Fake:** `FakeWebhookSink` — records dispatched payloads.

## Supporting types

All in `ports.ts`: `SessionId`, `TenantId`, `SessionContext`, `EntryRange`, `TimeRange`,
`SecretCategory`, `SecretCredentialRef`, `SecretBinding`, `NetworkPolicy`, `VolumeMount`,
`ResourceLimits`, `ExecOptions`, `ExecResult`, `ExecChunk`, `SandboxStatus`,
`SandboxMetrics`, `SnapshotId`, `SandboxHandle`, `ProvisionSpec` (incl. optional
`repos?: RepoCloneSpec[]`), `RepoCloneSpec`, `SessionEntry`, `InboundEvent`,
`OutboundEvent`, `SessionStatus`, `ObjectMeta`, `PutResult`, `TokenCounts`, `Usage`,
`Budget`, `BudgetCheck`, `WebhookEvent`.

These are **minimal** — only what the ports need to type their method signatures. The
full wire contracts (event payloads, request/response bodies, error envelopes) live in
`@pi-managed/contracts` (WP-0.9). Where a port carries an event payload, it is typed
`unknown` at the seam and narrowed by the contracts package; do not duplicate those
shapes here.

## Wiring note (monorepo)

`@pi-managed/testkit` declares a workspace dependency on `@pi-managed/backend` so the
fakes can `implements` the port interfaces (parity is checked at compile time). To run
`pnpm --filter testkit typecheck` standalone, build the backend first
(`pnpm --filter backend build`) so its `dist/` type declarations exist; `pnpm -r build`
and `pnpm -r test` do this in topological order.
