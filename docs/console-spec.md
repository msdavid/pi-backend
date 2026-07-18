# Web Console — Specification

> Status: **normative specification** for the web console. Normative for the
> console described in [`console.md`](console.md) (the design document —
> rationale, research, design language). This spec extends `docs/spec/spec.md`
> §26.6 and supersedes its "read-only, later phase" framing. Journeys:
> [`console-user-journeys.md`](console-user-journeys.md). (The phase/WP
> execution plan that built this was a working artifact under `tmp/`, not part
> of the published docs; the phase conformance gates live in
> `packages/web-console/test/phase*-gate/`.)
>
> Authority order for implementers: `docs/spec/spec.md` (platform behavior) →
> this spec (console behavior) → `docs/api-reference.md` (wire contract) →
> `CONVENTIONS.md` (binding engineering conventions).
>
> RFC-2119 language: **MUST** / **SHOULD** / **MAY**.

## §1 Purpose and scope

1.1 The console is a single-page web application served by the backend at
`/console`, giving every *human* persona of `docs/user-journeys.md` a browser
surface over the public `/v1` API.

1.2 **Parity rule.** The console MUST consume only the public `/v1` API plus
the console-support endpoints defined in §3–§4. It MUST NOT get private API
routes. (Corollary: anything the console can do, `curl` can do.)

1.3 **Non-goals (v1 of this spec):** a platform-admin surface (no `/v1`
platform-admin API exists, by design); payment forms / invoices / tax UI
(delegated to the billing adapter's hosted pages, §11); metering re-computation
client-side; native mobile apps.

1.4 The CLI (Pi client extension) remains the primary interactive client. The
console is the observation, administration, and anywhere-fallback surface
(§10). Surfaces MUST deep-link to each other: the extension prints
`/console/sessions/<id>` URLs; the console shows equivalent CLI commands where
an action is CLI-preferred (fork → resume, §10.4).

## §2 Definitions

- **Mode** — deployment presentation: `solo`, `team`, or `saas` (§5).
- **Scope** — API-key scopes per `api-reference.md` (`read`, `write`, `admin`).
- **Console session** — the server-side record binding a browser cookie to a
  validated API key (§4).
- **Ledger** — the tenant balance record set of §11 (saas mode).
- **DP-n** — design principles DP-1…DP-14 in [`console.md`](console.md) §3;
  they are normative for UI behavior and cited from this spec.

## §3 Serving, config, and headers

3.1 The backend MUST serve the built console at `/console` and `/console/*`
via the existing pre-auth `onRequest` hook (`packages/backend/src/api/console.ts`),
same-origin with `/v1`. Unknown `/console/*` paths (client-side routes) MUST
serve `index.html` (history-API fallback); asset paths keep extension-based
content types.

3.2 `GET /console/config` — public, unauthenticated. Response body exactly:

```json
{ "mode": "solo" | "team" | "saas", "onboardingEnabled": true|false }
```

Mode source: `CONSOLE_MODE` env var if set; otherwise derived
(`ONBOARDING_ENABLED=true` → `saas`, else `solo`). The endpoint MUST NOT
expose versions, instance ids, or any other configuration.

3.3 Mode is a **presentation concern only**. No `/v1` behavior may differ by
mode. A console in any mode against any backend MUST degrade gracefully
(e.g., `team` console on a saas backend simply shows no signup).

3.4 Security headers on all `/console*` responses: a CSP of
`default-src 'self'` (no inline script, no external hosts — everything
bundled, no CDN ever), `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`, and `frame-ancestors 'none'`.

## §4 Authentication: console sessions

4.1 The browser MUST NOT hold the API key in JavaScript-readable storage
(`localStorage`/`sessionStorage`/JS-visible cookies). The v1 console's
localStorage mechanism is retired.

4.2 `POST /console/session` — body `{ "apiKey": "..." }`. The backend
validates the key (existing auth path), and on success stores the key
reference server-side bound to a new random session id, returned as a cookie:
`HttpOnly; Secure; SameSite=Strict; Path=/`. Response body:
`{ "scopes": [...], "tenant": { id, name } }`. Invalid key → standard error
envelope, 401.

4.3 Requests from the console to `/v1/*` ride the cookie: the backend's auth
middleware MUST accept the console-session cookie as an alternative to the
`Authorization` bearer header, resolving to the same key → same scopes, same
rate limits, same audit identity. Bearer, when present, wins.

4.4 `DELETE /console/session` — destroys the server-side record and clears
the cookie (sign out). `GET /console/session` — returns
`{ scopes, tenant, expiresAt }` for the current cookie, 401 if none (used on
app boot).

4.5 **CSRF.** All state-changing requests authenticated by cookie MUST carry
the custom header `X-Console-Csrf: 1`; the backend MUST reject (403) mutating
cookie-authenticated requests without it. (Custom-header check; `SameSite=Strict`
is defense-in-depth, not the mechanism.) Bearer-authenticated requests are
exempt.

4.6 **TTL.** Console sessions expire server-side with a **sliding** TTL.
Defaults by mode: `solo` 30 days, `team` 7 days, `saas` 24 hours;
`CONSOLE_SESSION_TTL` overrides all. Revoking the underlying API key MUST
invalidate its console sessions on next use.

4.7 **Storage (decided, `console.md` §10.1):** a Postgres table
(`console_sessions`), so sign-out and key revocation delete server-side state
immediately and the sliding TTL is a column update. The implementing WP adds
the migration and an expiry-cleanup sweep, and regenerates `db-schema.md`.

## §5 Modes

5.1 `solo` — self-hosted single user. No signup surface. First-run sign-in
explains how to obtain the first key (spec §24 onboarding / journey P1.7).
Quota display de-emphasized. Settings includes a backend health widget reading
public `/healthz`/`/readyz`.

5.2 `team` — self-hosted multi-user. No signup surface. Key issuance and
rotation flows prominent in Settings; sign-in copy addresses issued keys and
least privilege.

5.3 `saas` — multitenant service. Signup page (§9.6) present iff
`onboardingEnabled`. Home leads with balance + burn (§11.8). Settings gains
Billing (§11.8).

5.4 Every mode difference MUST be expressible as: a route present/absent, a
copy variant, or an ordering/emphasis change. Anything else is a spec change.

## §6 Authorization presentation (scope-variant UI)

6.1 The UI derives capability purely from the scopes returned in §4.2/§4.4.
It MUST hide (not disable) top-level sections the key cannot use, and disable
(with explanation) inline actions within visible sections (DP-6).

6.2 Scope map (mirrors the platform's enforcement — the platform spec is
authoritative) — `read`: all browsing/observation surfaces. `+write`: session
interaction (create, message, interrupt, tool confirmation, fork), job
trigger, and resource-management mutations (agents, environments, vaults,
jobs, webhooks — the backend requires `write` for these). `admin`: API-key
management (issue/revoke — backend-enforced `admin`) and the Settings
surface. Disabled-action reasons MUST name the scope the backend actually
requires for that action.

6.3 A `read`-only console session MUST be visibly badged ("browsing
read-only"). A key with `admin` scope SHOULD trigger a one-time
least-privilege nudge (DP-8).

6.4 The backend remains the sole enforcer. Client-side hiding is UX, not
security; every mutating call still fails server-side without scope, and the
console MUST render such failures per DP-9 (error `code` + request id + doc
link).

## §7 Information architecture

7.1 Left sidebar, exactly these top-level items, filtered by scope and mode:
**Home**, **Sessions**, **Agents**, **Jobs**, **Resources** (environments ·
vaults · memory stores · files · skills), **Settings** (API keys · webhooks ·
tenant · billing[saas] · health[solo/team]). No deeper sidebar nesting; a
top-level item MAY swap in a contextual submenu (Resources, Settings).

7.2 **Home**: recents, favorites, active sessions, sessions in
`requires_action`, and the mode's headline strip (§5; DP-14: ≤5 metrics, with
trend). Favorites/recents are client-side per-browser state (no API).

7.3 **Sessions** is one list (DP-4): columns id, title, status, agent@version,
environment, created, cost; filters status/agent/environment; cursor
pagination per `api-reference.md`. Session detail tabs: **Trace** (default),
**Tree**, **Usage**, **Outputs**, **Conversation** (§10; phase-4).

7.4 **Trace tab**: chronological entries from `GET /v1/sessions/:id/entries`;
tool executions render name, input, output, truncation flag; event-type
filter; payloads collapsed by default and lazy-expanded (DP-2). While the
session is `running`, the trace live-tails via §8.

7.5 Sessions in `requires_action` MUST surface globally: sidebar badge + Home
section, not only on their own page.

7.6 Every rendered resource id is monospaced, one-click-copyable, and a link
to its detail route (deep-link rule, §1.4).

7.7 Empty states carry the create flow (scope permitting) *and* the
equivalent CLI command (DP-5). Destructive/terminal actions (archive agent,
delete vault, revoke key…) use typed confirmation naming real consequences
fetched from the API where available (DP-7).

## §8 Live streaming

8.1 Live views consume `GET /v1/sessions/:id/stream` (SSE) using **fetch
streaming**, not native `EventSource` (control over headers, reconnect, and
replay position). Reconnect MUST resume from the last seen position per the
api-reference SSE reconnect/replay contract; a dropped stream falls back to
entry polling with no missed events (mirrors the extension's degradation
behavior).

8.2 Live data updates the TanStack Query cache (invalidation/patch); no
parallel state store.

8.3 **Ambient status (DP-11).** The document title and favicon MUST reflect
the viewed session's status (running / completed / failed /
`requires_action`) so a background tab is informative.

## §9 Screens — normative minimums

Per-resource screens MUST cover at least the operations listed; all via
public `/v1` routes as documented in `api-reference.md`.

- 9.1 **Agents** (admin): list, detail with version history, create, PATCH
  (creates new version — UI MUST say so), archive (terminal; DP-7 dialog MUST
  state auto-archival of referencing jobs).
- 9.2 **Environments** (admin): list/create/edit/archive/delete; `cloud` shows
  image/resources/network policy with one-line policy explanations (DP-6);
  `self_hosted` detail shows worker keys (mint = §T5), `work-stats`
  (depth, oldestQueuedAt, workersPolling) and drain (`work-stop`, with
  `{force}` as an explicit second step).
- 9.3 **Vaults & credentials** (admin): create vault, add credential by
  category, validate button, archive. Secret fields are write-only: the UI
  MUST NOT display, echo, or retain secret values after submit (DP-8), and
  MUST explain the `model_provider_key` fail-closed rule (DP-6).
- 9.4 **Jobs**: list/detail/runs (all scopes); create/pause/unpause/archive/
  manual-run (`write` per the API — see §6.2); auto-paused jobs
  MUST show their pause reason prominently.
- 9.5 **Memory stores / files / skills**: list + detail + content viewing per
  API; memory version history with restore (restore requires the backend
  restore op — WP-C4.0; until it ships the history is audit-only and the UI
  says so); mutations `write`-scoped per the API (§6.2).
- 9.6 **Onboarding (saas)**: signup form → `POST /v1/onboarding/signup` →
  key shown exactly once (copy-and-confirm) → first-run checklist (model key →
  agent → first session; DP-12). MUST NOT require payment details. Once §11
  ships, signup also grants the trial balance per §11.1 (email-verification
  gated); before that, saas signup simply has no balance mechanics.
- 9.7 **API keys** (admin): list, issue (scopes opt-up from `["read"]`,
  secret shown once), revoke (DP-7).
- 9.8 **Webhooks** (admin): register (event-type picker), `whsec_` shown once,
  test-delivery button, auto-disabled state surfaced with re-enable path.
- 9.9 **Tenant / usage**: quota-vs-limit, spend over time (per §11.5
  endpoints when available; per-session aggregation until then), breakdown by
  agent and `metadata.userId`. Cost observability is all-modes (§11.2).

## §10 Conversation view ("continue from any browser")

10.1 A `write`-scoped user MUST be able to continue an idle session from the
browser: composer sends `user.message` events (waking the session), replies
render via §8. Seed rendering uses `GET /v1/sessions/:id/messages`; the
Conversation lens is conversation-shaped, distinct from Trace (DP-4).

10.2 Turn lifecycle: messages sent mid-turn queue **client-side** — the API
rejects mid-turn `user.message` events (`409 session_not_idle`, ROB-5), so
the console holds queued messages and dispatches them at the next turn
boundary, rendering the queue honestly (queued state visible, nothing
silently dropped, surviving tab switches); interrupt is available;
`requires_action` requests surface in the composer area itself.

10.3 The view MUST state resume caveats inline where relevant: processes from
prior turns are not preserved; outputs are downloadable but there is no local
cwd (DP-6).

10.4 A "continue in Pi instead" affordance shows `/remote:resume <id>`.

10.5 Layout MUST be usable on a phone-width viewport. **Responsive-only
(decided, `console.md` §10.5):** no PWA manifest or service worker — a service
worker interacts with §3.4 CSP and §4 cookie auth and the option was
deliberately declined for phase 4.

## §11 Commercialization facilities (saas)

11.1 **Model.** Prepaid, single-unit (dollars). No plans, tiers, seats,
subscriptions, or entitlement mapping. **One price line (decided,
`console.md` §10.7):** marked-up model spend; sandbox compute is absorbed
into the rate, guarded by concurrent-sandbox quotas and idle-session caps —
there is no second meter. Tenant lifecycle: `trial → active`, plus
`suspended` (balance ≤ 0). **Trial grant (decided, §10.8): $5 at signup, no
card, activated only on email verification** — the verification flow (token +
a minimal email-sender seam) is defined by the implementing WP; the console
MUST surface the unverified state and the resend action. Suspension is
fail-soft: reads MUST work; new sessions/turns MUST NOT start; running work
stops as `budget_exhausted` semantics already stop it. No `past_due` state
exists.

11.2 **Cost observability ≠ billing.** Usage/spend display (§9.9) is
all-modes core; balance/top-up is a saas-mode layer on the same data.

11.3 **Ledger.** Balance and its history (grants, top-ups, drains,
adjustments) live in backend Postgres; every entry carries an idempotency
key. The backend ledger — not any payment engine — is the source of truth for
usage and balance. Enforcement (11.1) reads only local ledger state; nothing
in a request path calls a payment engine.

11.4 **Metering export.** `BILLING_SINK=webhook` events get a documented
schema: idempotency key, tenant id, time-bucketed aggregated quantities
(never per-turn). Additional sinks (e.g. `stripe`) are additive
implementations of the same seam.

11.5 **Usage-over-time API.** Tenant-scoped, time-bucketed usage (day/month
granularity; by agent; by `metadata.userId`) exposed on `/v1` (exact routes
defined in the implementing WP against api-reference conventions; the wire
contract lands in `contracts` + `api-reference.md` first).

11.6 **Threshold events.** Webhook event types `tenant.balance_low`
(configurable threshold) and `tenant.balance_exhausted`, emitted through the
existing webhook subsystem. Consumed alike by console banner, email, and
auto-charge.

11.7 **Billing adapter.** All payment-engine code (Stripe as reference) lives
in `packages/billing-adapter` — the payment SDK appears nowhere else. The
adapter: creates hosted checkout/portal URLs on request; consumes payment
webhooks; credits the ledger through a narrow machine-credential provisioning
surface (host-agent auth pattern; NOT a tenant API key). Ledger credit from a
payment event MUST be idempotent under webhook replay.
**Auto-charge** (opt-in, off by default): threshold + amount; saved payment
method and off-session charging are adapter-internal; hard caps per day and
per month; auto-disable + notify after N consecutive failures (no silent
retries); every auto-charge appears in the ledger like any top-up.

11.8 **Console (saas).** Home: balance, burn sparkline, "lasts ~N days at
current rate". Settings → Billing: balance, ledger history, top-up (link-out
to hosted checkout), auto-charge toggle (threshold/amount/caps/last-charge
visible), receipts link-out. With no adapter configured, money buttons are
absent and everything else works. `suspended` state shows exactly what still
works and the single fixing action (DP-9).

11.9 The console MUST NOT compute money client-side; it displays what the API
reports.

## §12 Performance, accessibility, quality budgets

12.1 Initial JS ≤ 200 KB gzipped; route-level code splitting. First
meaningful paint < 1 s against a local backend; interaction latency < 100 ms.
Budgets are CI-enforced from phase 1 (DP-10).

12.2 Keyboard navigability for all tables/dialogs/forms; ARIA live regions on
streaming views; axe-core clean on every route; both themes contrast-safe
(DP-13). Light + dark theme from day one.

12.3 Web-console package tests follow `CONVENTIONS.md` binding rules —
notably *fakes at the seam*: API-client contract tests run against the real
in-process Fastify app (via `testkit`), not a stubbed `fetch`.

## §13 Conformance checklist (per release)

- [ ] §1.2 no non-`/v1` calls beyond §3–§4 endpoints (build smoke test greps).
- [ ] §3.4 CSP present; zero external requests in a full route crawl.
- [ ] §4.1 no API key in any JS-readable storage after sign-in.
- [ ] §4.5 mutating cookie-auth request without CSRF header → 403.
- [ ] §6.1 scope matrix: each scope sees exactly its surfaces.
- [ ] §8.1 stream drop → resume with no missed/duplicated entries.
- [ ] §9.3 no secret value appears in any response fixture or DOM snapshot.
- [ ] §11.7 payment webhook replay credits ledger exactly once.
- [ ] §12.1 budgets green in CI; §12.2 axe-core clean.
