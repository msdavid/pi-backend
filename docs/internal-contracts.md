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
- **State machine:** `idle → running → rescheduling → terminated` (§6.3; 3 retries with
  exponential backoff).
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
- **Consumers:** WP-P0.3 (impl: local fs + S3-compatible + GCS), WP-1.5 (JSONL sync), WP-1.12
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
- **Enriched payload (`data`).** `WebhookEvent` carries an optional
  `data?: Record<string, unknown>`, delivered verbatim in the payload. It is absent for
  every event type except the balance thresholds (below), which need the at-crossing
  balance that a later GET cannot recover. Existing thin payloads are byte-identical.

### `BillingSink` — metering export seam (§11.4, WP-C5.2)

- **File:** `packages/backend/src/domain/billing/sink.ts` (`BillingSink`, `MeteringEvent`).
- **Spec:** console spec §11.4 (metering export). Wire schema `MeteringEvent` lives in
  `@pi-managed/contracts` (single source a sink consumer validates each delivery against).
- **Method:** `recordMetering(MeteringEvent) → Promise<void>`. At-least-once; MUST NOT
  throw (metering is best-effort — never blocks or fails usage recording).
- **Event shape.** Aggregated + **time-bucketed, never per-turn**: `{ idempotencyKey,
  tenantId, bucketStart, bucketEnd, requestCount, inputTokens, outputTokens,
  cacheCreationInputTokens, cacheReadInputTokens, totalTokens, usdCost }`. Recipients
  dedup on `idempotencyKey` (stable per `(tenant, bucketStartEpochMs)`).
- **Producer — `MeteringAggregator`** (`domain/billing/metering.ts`): the recorder's
  `onMetering` hook. It sums each model request into a per-`(tenant, bucket)` accumulator
  (bucket width `BILLING_METERING_BUCKET_MS`, default 60 s) and, on its flush loop, emits
  one aggregated event per closed bucket AND (when `BILLING_ENABLED`) drains the ledger a
  matching `debit` — the usage→debit bridge that powers §11.1 enforcement and the §11.6
  threshold events. Idempotent both ways (export dedups on `idempotencyKey`; the debit on
  the ledger's UNIQUE key). The accumulator is in-memory: `flushAll()` drains it on
  graceful shutdown; a hard crash loses at most one un-flushed bucket window (bounded
  under-count, never an over-charge).
- **Impls:** `NoopBillingSink` (default; billing disabled) · `WebhookBillingSink`
  (HTTPS + `X-Webhook-Signature`, SSRF-pinned egress). Selected by `createBillingSink`
  from `BILLING_SINK`. Additional sinks (e.g. `stripe`) are additive implementations.

### `EmailSender` (console spec §11.1 — WP-C5.1)

- **File:** `packages/backend/src/domain/ports.ts` (`EmailSender`, `OutgoingEmail`).
- **Spec:** console spec §11.1 (trial email-verification).
- **Method:** `send({ to, template, vars }) → Promise<void>`. `template` names a
  server-side template; `vars` are its substitutions (the verification `token` /
  link). **No credential is ever passed through this seam** — the provider's API key
  is the sender impl's own config, never the harness's.
- **Default impl:** `NoopEmailSender` (`domain/email/noop-email-sender.ts`) — the
  dev/test default (and the composition-root default via `NOOP_EMAIL_SENDER`). It
  delivers nothing and **records** each message in `.sent` so a dev flow / integration
  test can read the verification token (mirrors `NOOP_BILLING_SINK`).
- **Real-sender contract:** a production saas deployment injects a real sender (SES /
  Postmark / SMTP) as `createApp({ emailSender })`. The impl MUST: deliver
  `template`+`vars` to `to`; never throw for a transient failure in a way that fails
  sign-up (provisioning swallows send errors — the tenant can resend); and keep the
  provider SDK + credential **entirely inside the impl** (§25.5 posture). It is
  env-configured; the WP that ships a real sender adds its `EMAIL_*` env vars.
- **Consumers:** `domain/billing/trial.ts` (`provisionTrial` / `resendVerification`),
  wired through `onboardingRoutes` + `billingRoutes`.

## Machine credit-surface (console spec §11.7 — WP-C5.1)

The narrow, MACHINE-authenticated seam the billing adapter (`packages/billing-adapter`,
WP-C5.3 — a separate process) calls to credit a tenant's ledger after a payment
webhook. **It is an internal channel, not a public `/v1` route**, and it is NOT a
tenant API key — it can credit any tenant, so it never rides the tenant auth path.

- **Wire:** `POST /internal/billing/credit`. Body:
  `{ tenantId, amountMicros (positive int µUSD), idempotencyKey, source?, metadata? }`.
  Response `200 { entryId, applied, lifecycle, balanceMicros, balanceUsd }`.
- **Auth:** `Authorization: Bearer <token>` where `<token>` is the per-deployment
  shared secret `BILLING_PROVISION_TOKEN` (config). Constant-time compared (SHA-256
  digest + `timingSafeEqual`), the **host-agent auth pattern** (`infra/sandbox-host-
  pool/auth.ts`). **Fail-closed:** an unset/blank secret rejects EVERY request `401`.
  On `PUBLIC_PATHS` so the tenant bearer-auth hook skips it; the plugin does its own
  machine auth in a preHandler (a tenant API key → `401`).
- **Idempotency (the money invariant, §11.7/§13):** the same `idempotencyKey` credits
  the ledger EXACTLY once under webhook replay — enforced by the ledger's
  `UNIQUE (tenant_id, idempotency_key)` constraint; a replay returns the existing entry
  with `applied: false` and no balance change.
- **File:** `packages/backend/src/api/billing-internal.ts` (`billingInternalRoutes`,
  `BILLING_CREDIT_PATH`). Credit lands via `domain/billing/ledger.ts` `appendEntry`.

## Adapter internal surface — checkout / portal / auto-charge (console spec §11.7–11.8 — WP-C5.3 F4)

The REVERSE machine channel of the credit-surface: the adapter's inbound HTTP surface
that the backend's SDK-free `/v1` link-out proxy calls to reach the payment engine. It
closes the W15 top-up + auto-charge-controls gap. **Internal channel, not a `/v1`
route**, same trust posture as the credit-surface (a shared machine bearer, NOT a
tenant key).

- **Direction:** backend → adapter (the credit-surface is adapter → backend). The
  backend proxy resolves the tenant from its own auth, then forwards the tenant id.
- **Wire** (`packages/billing-adapter/src/internal-api.ts`):
  - `POST  /internal/adapter/checkout`    `{ tenantId, amountUsd }` → `{ url }` (the
    reference engine needs an explicit amount; the adapter does the ONE USD→micros
    conversion at the engine boundary, §11.9).
  - `POST  /internal/adapter/portal`      `{ tenantId }` → `{ url }`; `409` when the
    tenant has no saved payment method (NOT `404` — `404` means "no adapter").
  - `GET   /internal/adapter/auto-charge?tenantId=…` → contract `AutoChargeConfig`;
    an unconfigured tenant returns a default-OFF config (`200`, never `404`).
  - `PATCH /internal/adapter/auto-charge` `{ tenantId, enabled?, thresholdUsd?, amountUsd? }`
    → the updated contract `AutoChargeConfig`.
- **Auth:** `Authorization: Bearer <BILLING_PROVISION_TOKEN>` — the SAME per-deployment
  shared secret, constant-time compared (SHA-256 + `timingSafeEqual`), **fail-closed**
  (unset/blank secret or a tenant key → `401`).
- **Backend proxy** (`packages/backend/src/api/billing.ts`): the four
  `/v1/tenant/billing/{checkout,portal,auto-charge}` routes forward here when
  `BILLING_ADAPTER_URL` + `BILLING_PROVISION_TOKEN` are set; unset ⇒ `404` (the console's
  no-adapter state, §11.8). An adapter `4xx` surfaces with its status; a `401`/`5xx` or
  unreachable adapter collapses to `502`. **No payment SDK enters `packages/backend`**;
  these routes issue URLs / read-write config only — no money math, no ledger write.

## Balance-threshold events (console spec §11.6 — WP-C5.2)

Webhook event types `tenant.balance_low` (threshold `BILLING_LOW_BALANCE_THRESHOLD_MICROS`,
default $2, global config) and `tenant.balance_exhausted` fire when a ledger debit CROSSES
the line — the tenant-notification half of the prepaid model, consumed alike by the console
banner, email, and the auto-charge engine (WP-C5.3).

- **Seam:** `domain/billing/threshold.ts` `appendEntryWithThresholdEvents(pool,
  eventSource, input, thresholdMicros)` — `appendEntry` + crossing detection + emit through
  the existing `WebhookEventSource`. Fires exactly once per crossing (`detectBalanceCrossings`
  compares the applied entry's pre/post balance; `balance_low` only while post > 0, so a
  debit straight to ≤ 0 fires only `balance_exhausted`). A ledger idempotency-key replay
  (`applied: false`) emits nothing. The metering aggregator's drain is the production caller.
- **Payload:** carries `data: TenantBalanceEventData` (`@pi-managed/contracts`) —
  `{ entryId, tenantId, balanceMicros, balanceUsd, thresholdMicros, thresholdUsd, lifecycle }`
  — the at-crossing balance a consumer needs without a round-trip. `entryId` (the causing
  ledger debit) is the crossing's stable identity: the auto-charge engine derives its
  charge idempotency key from it (`autocharge:<entryId>`), so a redelivered event charges
  the card at most once (WP-C5.3 F1). Delivery is tenant-scoped (enqueued only to the
  tenant's own webhooks), so events are cross-tenant isolated.

## Billing adapter — payment-engine seam (console spec §11.7 — WP-C5.3)

`packages/billing-adapter` (`@pi-managed/billing-adapter`) is the payment engine
(Stripe reference), a **separate process** — the Stripe SDK is imported in exactly
one file there (`src/stripe-engine.ts`) and appears in no other package (grep-asserted).
It consumes the two backend seams above; it never rides a `/v1` route.

- **`PaymentEngine` seam** (`src/types.ts`): `createCheckoutUrl` / `createPortalUrl`
  (hosted URLs the console links out to — the console never sees a card, §11.9),
  `verifyWebhook` (throws unless the signature verifies), `chargeOffSession`
  (auto-charge). Stripe lives behind this one interface; a different engine is a
  second impl. The single ledger-idempotency-key derivation
  (`creditKeyForPayment(paymentRef) → "stripe:<id>"`, `src/credit-key.ts`) is shared
  by the webhook consumer and the auto-charge engine, so a payment credits **exactly
  once** no matter how many times, or through which path, it arrives.
- **Consumes the machine credit-surface** via `HttpLedgerClient` (host-agent bearer
  `BILLING_PROVISION_TOKEN`, real HTTP) — the sole way a payment reaches the ledger.
- **Consumes `tenant.balance_low`** via `AutoChargeEngine.onLowBalance` — opt-in/off
  by default; hard per-day and per-month caps (never exceeded); auto-disable + notify
  after N consecutive failures. Saved-method + off-session charging are adapter-
  internal; every auto-charge lands in the ledger like any top-up. The charge
  idempotency key is derived from the crossing's stable `entryId` (`autocharge:<entryId>`,
  WP-C5.3 F1), so a redelivered `tenant.balance_low` charges once; `onLowBalance` is
  serialized per tenant (an in-process keyed mutex, F2) so concurrent crossings never
  race the cap (a multi-process store must also reserve transactionally).
- **Exposes the internal surface** (`src/internal-api.ts`) the backend proxy calls for
  checkout / portal / auto-charge — see "Adapter internal surface" above.
- **Config** is env-sourced and fail-closed (`src/config.ts`) — see `docs/deploy.md`
  §"Billing adapter". No credential ships in the package; tests supply none (they
  inject a fake engine or a locally-generated, obviously test-only signing secret).

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
