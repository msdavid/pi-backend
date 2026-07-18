# Pi Managed Backend — Web Console: Consolidated Plan

> Status: **design document** for the web console — rationale, research, and
> design language behind [`console-spec.md`](console-spec.md) (normative) and
> [`console-user-journeys.md`](console-user-journeys.md). Supersedes the
> read-only v1 console described in `packages/web-console/README.md` and
> spec §26.6.
>
> Grounded in `docs/user-journeys.md`, `docs/api-reference.md`, and
> `packages/contracts`. External research sources are listed at the end.

---

## 1. What the console is

A single web application, served same-origin at `/console`, that gives every human
persona in [`user-journeys.md`](user-journeys.md) a browser surface over the
same `/v1` API the CLI and extension use.

**The console complements the CLI; it never competes with it** (the Fly.io stance:
CLI-first, but a first-class dashboard). The Pi coder's primary surface stays
`/remote:*` in the terminal; the console is where you go to *look* — traces, live
session views, fleet-of-sessions overviews, and the management work (vaults, keys,
webhooks) that terminals render poorly — and, once the observation surfaces are
solid, where you can **continue a session from any browser** (§5a) when no Pi is
at hand. The CLI remains the richer client (local cwd integration, output
pulling, `defaultAgent`); the browser conversation is the anywhere-fallback, not
the primary driver.

Two rules follow from this:

1. **CLI/UI parity on one API.** The console speaks only public `/v1` (plus the two
   tiny console-support endpoints in §8). It never gets private endpoints.
2. **Deep links everywhere.** The client extension prints console URLs
   (`/console/sessions/<id>`) alongside session ids; every id shown in the console
   is itself a link. The terminal and the browser reference the same objects.

### Personas = key scopes, not accounts

The backend's access model is explicit: personas are roles distinguished by API-key
scope, not account types. The console mirrors this — **one app, scope-variant UI**:

| Key scope | Unlocks |
|---|---|
| `read` | Browse everything: sessions, traces, usage, resources. Zero risk — the "test mode" of this console. |
| `read`+`write` | Session interaction: send messages, interrupt, answer `requires_action`, fork, create sessions/jobs. |
| `admin` | Management: agents, environments, vaults, API keys, webhooks, tenant settings. |

The backend remains the sole enforcer. The UI only hides doors the key cannot open
(and shows a "browsing read-only" badge rather than failing on click).

**Platform admin is explicitly out of scope.** There is no `/v1` platform-admin API
by design; that persona's surface remains shell + Grafana (`docs/dashboards/`).
Building a web UI for P1–P7 would mean inventing a new authenticated backend
surface — a separate decision, not part of this plan.

---

## 2. Deployment modes

The console must serve three deployment shapes. Same build, same code — the mode
changes emphasis, copy, and which flows exist, never the architecture.

| | **Solo** (self-hosted, single user) | **Team** (self-hosted, multi-user) | **SaaS** (multitenant service) |
|---|---|---|---|
| Who | One person wearing all three hats | One tenant; an admin issues scoped keys to teammates | Many tenants; self-service signup |
| Onboarding | No signup page. First-run explains how to mint the first key (P1 step 7) or paste the one you were handed | No signup page. Admin-driven: key-issuance flows are prominent | Public signup page (`POST /v1/onboarding/signup`) behind `ONBOARDING_ENABLED` |
| Home emphasis | Your sessions, recents. Quota bar de-emphasized (limits are yours to set) | Team sessions (scope toggle), key hygiene nudges, work-queue health for self-hosted envs | Balance + burn rate (§2a), spend, active sessions |
| Settings section | Keys, webhooks + a backend health widget (`/readyz` is public; solo operators double as platform admin, this is the one hat-tip to that) | Keys (issuance + rotation front and center), webhooks, tenant info | Keys, webhooks, tenant info, Billing (balance, top-up, auto-top-up, receipts link — §2a), install instructions reprint |
| Sign-in copy | "Paste your API key" | "Paste the key your admin issued" + least-privilege explainer | "Sign in with your key or create a tenant" |

### Mode detection

The console learns its mode from a tiny **public, unauthenticated** config endpoint
served by the same pre-auth hook that serves the static assets:

```
GET /console/config → { "mode": "solo" | "team" | "saas", "onboardingEnabled": bool }
```

- `CONSOLE_MODE` env var sets it explicitly.
- Default derivation: `ONBOARDING_ENABLED=true` → `saas`, else `solo`.
- The endpoint exposes nothing sensitive — mode and a boolean, no versions, no
  config values.

Mode is a *presentation* concern only. No API behavior differs by mode; a `team`
console pointed at a SaaS backend still works, it just doesn't show signup.

---

## 2a. Commercialization: pay-per-use, one unit

> Applies to **saas** mode only, but the cost-observability layer it sits on is
> for all modes. Decision: **no plans, no tiers, no seats — a prepaid dollar
> balance that usage drains.** Simplicity for developers is the product goal;
> the pricing page must fit in a sentence.

### The model

- **One unit: dollars.** No invented "credits" with a conversion rate to learn.
  Developers already reason in API-spend dollars (the OpenAI/Anthropic mental
  model). **One price line:** marked-up model spend; sandbox compute is
  cost-of-goods absorbed into the rate (decision §10.7), with quota guardrails
  against compute-heavy/token-light abuse.
- **Prepaid.** Signup grants a **$5 trial balance** (no card) that activates
  on email verification (decision §10.8). Top up via a one-time payment.
  Prepaid means no surprise bills for the user and no dunning/failed-payment
  machinery for us.
- **Optional auto-charge** (the OpenRouter pattern): off by default; the user
  opts in with a threshold and an amount ("when balance drops below $10,
  charge $50 to my saved card").
  - *Mechanics:* requires a saved payment method and off-session charging —
    both live entirely in the billing adapter (Stripe: SetupIntent to save the
    card, off-session PaymentIntent to charge; the backend only ever sees
    "credit the ledger"). The backend's part is a `tenant.balance_low`
    threshold event the adapter subscribes to — the same event the console
    banner and email use.
  - *Safety rails (non-negotiable):* a cap on auto-charges per day and per
    month (a runaway agent must not drain a card); automatic disable after N
    consecutive payment failures, notifying the user and falling back to
    manual top-up — never silent retry loops; every auto-charge appears in the
    ledger and in the console like any other top-up.
  - *Console UX:* a single toggle with threshold + amount fields, the monthly
    cap visible next to it, and "last auto-charge: $50 on …" so the state is
    never mysterious. Enabling it from the low-balance banner is one click.
- **Balance exhausted = fail-soft.** Reads always work; new sessions/turns
  don't. Running sessions stop the same way `budget_exhausted` already stops
  them. Data is never held hostage.
- **Tenant lifecycle collapses to:** `trial → active`, plus `suspended`
  (zero balance). No `past_due` — prepaid can't be past due.

### Cost observability ≠ billing

Cost observability — spend over time, by agent / session / user
(`metadata.userId`) — is a **core console feature in every mode**: a solo
self-hoster pays their model provider real dollars and this is arguably why
they open the console at all. Billing (balance, top-ups) is a thin saas-mode
layer on the same data and the same screens. One usage dashboard, built once.

### Facilities we build now (engine-agnostic seams)

It is not our job to build a payment engine. We build the seams that make
plugging one in (Stripe as the reference case) an adapter, not a project:

1. **Ledger in our Postgres** — balance, grants, top-ups, usage drains, each
   entry idempotency-keyed. **Our DB is the source of truth for usage and
   balance**; the payment engine only ever processes payments (this matches
   Stripe's own guidance: their meter summaries are for invoicing, not for
   customer-facing usage display).
2. **Metering events fit for forwarding** — the existing `BILLING_SINK=webhook`
   events get a documented schema: idempotency key, tenant id, time-bucketed
   aggregated quantities (never per-turn spam). A future `BILLING_SINK=stripe`
   is then a second thin sink.
3. **Usage-over-time endpoints** — time-bucketed tenant usage (day/month, by
   agent and `metadata.userId`). Serves the all-modes cost dashboard and the
   saas balance view alike.
4. **A narrow provisioning surface** — the payment-webhook consumer ("Checkout
   session completed → credit tenant balance") lives in a separate
   `packages/billing-adapter`; the payment engine's SDK appears *only* there.
   It talks to the backend via a narrowly-scoped machine credential (host-agent
   pattern), since there is deliberately no platform-admin `/v1` API. Enforcement
   reads only local ledger state — never calls the payment engine in a request
   path.
5. **Threshold webhooks** — `tenant.balance_low`, `tenant.balance_exhausted`
   event types, consumed by the console (banner), email, and auto-top-up alike.
6. **Quotas stay, as guardrails not tiers** — concurrent-session/sandbox
   ceilings remain abuse protection with generous defaults, invisible in the
   pricing story.

### What we deliberately do not build

Payment forms, invoice PDFs, tax logic, dunning, subscriptions, plan catalogs,
entitlement mapping, seat management. Checkout and receipt/invoice history are
the payment engine's hosted UI — the console links out. The console never
recomputes cost client-side; it displays what `/v1` reports (one source of
truth for a number people will dispute).

*Known trade-off, accepted:* enterprises sometimes want postpaid invoicing.
The ledger + adapter seams admit a postpaid mode later without schema changes;
we don't build it now.

### Console UX (saas mode)

- **Balance is a first-class Home element**: current balance, burn-rate
  sparkline (DP-14), "at the current rate this lasts ~N days".
- **Top up = one click** out to hosted checkout; auto-top-up is a toggle with
  amount/threshold, state shown plainly.
- **Low-balance banner** at threshold; `suspended` shows exactly what still
  works and the one action that fixes it (DP-9 applied to money).
- Per-session and per-agent cost already appear throughout (DP-1); the billing
  view adds nothing new to learn.

---

## 3. Design principles

Numbered so reviews can cite them ("violates DP-4"). Distilled from the research
rounds (Productboard, Vercel, Stripe, Fly.io, LangSmith/Langfuse, 2026 SaaS/UX and
OWASP guidance) and this backend's own invariants.

- **DP-1 — Crucial facts first.** Every entity page leads with its 2–3 decisive
  facts (session: status + stop reason, agent@version + environment, cost so far;
  job: schedule, last run outcome, next fire). Everything else is below the fold.
  *(Vercel)*
- **DP-2 — Progressive disclosure.** Summaries before detail; payloads load lazily.
  Agent traces are megabytes of nested JSON — never render what wasn't asked for.
  *(LangSmith/Langfuse, dashboard UX research)*
- **DP-3 — Calm, scannable, dense.** Type hierarchy does the work of boxes: ~6
  text styles, minimal borders, no card grids for data. A console glanced at while
  coding must be scannable, not decorative. *(Stripe)*
- **DP-4 — One list, many lenses.** One record, multiple visualizations — session
  detail is *trace* / *tree* / *usage* tabs over the same data; the session list is
  one grid with scope and status toggles, not separate pages per filter.
  *(Productboard)*
- **DP-5 — Empty states teach.** Every empty list carries the create flow *and*
  the equivalent CLI command. First-run shows sample data ("this is what a trace
  looks like") rather than blank grids. *(Productboard, onboarding research)*
- **DP-6 — One line of microcopy per concept.** Every entity explains itself in
  place: what an environment is, that archival is terminal, why a vault needs a
  `model_provider_key`. The journeys doc has this language written — reuse it.
  *(Productboard teardown's "What is a Portal?" failure)*
- **DP-7 — Destructive actions state consequences.** Typed confirmation with
  explicit consequence language sourced from real API behavior ("archiving this
  agent auto-archives 3 scheduled jobs"). *(admin-panel UX research; our API)*
- **DP-8 — Secrets are shown once or never.** Key/`whsec_` values render exactly
  once at creation with copy-and-confirm; vault secret fields are write-only
  end-to-end. Nudge toward least privilege: "you're browsing with an admin key —
  issue a read key instead." *(Stripe key practices; our API contract)*
- **DP-9 — Errors are actionable.** Surface the API's error `code`, the request
  id, and a link to the relevant `api-reference.md` section. Never a bare toast.
  *(Stripe DX)*
- **DP-10 — Performance is a feature with a budget.** Targets set in phase 1 and
  tested: < 200 KB gzipped initial JS, first meaningful paint < 1 s on localhost,
  interaction < 100 ms. Realtime via SSE + query invalidation, not polling loops.
  *(Vercel)*
- **DP-11 — Status is ambient.** Session status shows in the favicon/tab title
  (running / completed / `requires_action`), so U2's "you keep coding" works with
  the console in a background tab. *(Vercel deployment tabs)*
- **DP-12 — First minute to first value.** In every mode, a first-time user
  reaches something real in under a minute: solo/team → paste key, see your
  sessions; SaaS → signup, key shown once, checklist (model key → agent →
  first session). One path, no simultaneous checklists/videos/invites.
  *(onboarding research; Productboard's overload as anti-pattern)*
- **DP-13 — Accessible by default.** Keyboard-navigable tables and dialogs, ARIA
  on live regions (streaming views), contrast-safe in both themes. Not retrofit.
- **DP-14 — 3–5 metrics, with trend.** The Home/tenant view shows quota bar,
  spend, active sessions — each with a sparkline — and nothing else. *(Stripe,
  dashboard research)*

---

## 4. Design language

- **Look:** restrained developer-platform monochrome — near-black/near-white
  surfaces, one accent color for primary actions and live/running states, semantic
  colors reserved for status only (running / idle / failed / `requires_action` /
  budget-exhausted). Light and dark themes from day one via design tokens.
  *(Vercel/Geist family aesthetics, Stripe calm density)*
- **Typography:** system font stack + a monospace face for ids, keys, JSON, and
  logs. Fixed scale of ~6 styles (display, title, section, body, small, mono);
  weight and size establish hierarchy, borders and boxes do not.
- **Density:** tables and definition lists over cards. Row height compact;
  whitespace between sections, not around every element.
- **Ids as first-class UI:** prefixed ids (`sess_`, `agent_`, `key_`…) render in
  mono with one-click copy, and are always links (DP re: deep links).
- **Status chips:** one shared component maps every lifecycle in
  `contracts` (session status, job state, webhook health, credential validity) to
  the same visual vocabulary.
- **Components:** a small owned design system (`components/`) — button, input,
  table, dialog, tabs, chip, toast, empty-state, sparkline, JSON viewer, SSE log
  view. No external component library; no CDN assets ever (CSP enforces this).
- **Motion:** none decorative. The only animation is state change (stream lines
  appearing, status chip transitions).

---

## 5. Information architecture

Productboard-style flat sidebar, ≤ 6 top-level items, scope- and mode-filtered:

```
┌──────────────────────────────────────────────────────────────┐
│ Home        personalized: recents, favorites, active         │
│             sessions, quota/spend strip (DP-14)              │
│ Sessions    one list, scope/status/agent/env toggles (DP-4)  │
│             → detail: Trace | Tree | Usage | Outputs tabs    │
│ Agents      agents + their versions; jobs nested per agent   │
│ Jobs        schedules, run history, pause/unpause/trigger    │
│ Resources   environments · vaults · memory stores · files ·  │
│             skills (submenu swaps in, no deeper nesting)     │
│ Settings    API keys · webhooks · tenant/plan · health       │
│             (admin scope only; health widget all modes)      │
└──────────────────────────────────────────────────────────────┘
```

- **Session detail is the flagship screen.** Trace tab = chronological entries
  (`GET …/entries`) with tool calls as first-class nodes, filter by event type,
  lazy payload expansion; live tail via SSE (`GET …/stream`, fetch-based — the
  native `EventSource` cannot send auth and our session cookie makes this moot,
  but fetch-streaming is still used for reconnect/replay control). Tree tab =
  `GET …/tree` fork/branch structure. Usage tab = tokens + USD. Outputs tab =
  list + download. Conversation tab (§5a, phase 4) = continue the session from
  the browser.
- **`requires_action` surfaces globally:** a session waiting on a tool
  confirmation shows in the sidebar badge and Home, not only inside its own page
  (U8).
- **Journey coverage map:** U2/U3/U8 → Sessions (live view, steer, interrupt,
  confirm); U4 → Sessions list from any browser: view + fork from phase 2,
  **continue in the browser** via the Conversation tab from phase 4 (§5a);
  U5 → Jobs; U7 → Resources/Memory; T1/T7 → Home + Settings/tenant;
  T2 → Settings/keys; T3 → Agents + Resources/environments; T4 → Resources/vaults;
  T5 → Resources/environments (worker keys, work-stats, drain); T6 →
  Settings/webhooks (+ test button); T8 → agent permission policies + the trace
  as audit log.

### 5a. Continue from any browser (Conversation view)

The console's one driver-role surface: a conversation-first lens on a session
that lets a user with `write` scope **wake an idle session and keep working from
any browser** — no Pi installed (U4's "resume anywhere", browser edition; also
the full-message answer path for a phone/tablet).

- **Mechanics:** entirely on existing `/v1` — `user.message` events wake the
  session (cold-wake from the durable log) and start turns; the SSE stream
  renders the reply. No new backend surface.
- **UX scope (why it's its own phase):** a proper composer, turn lifecycle
  (queued follow-ups while a turn runs, interrupt), conversation-style rendering
  of agent output (`GET …/messages` as the seed, distinct from the Trace lens per
  DP-4), and a mobile-usable layout. This is deliberately *not* the steer box
  from phase 2 grown bigger — it is designed as a conversation surface.
- **Honest boundaries, stated in the UI (DP-6):** processes from a previous turn
  are not preserved (the agent is told this in its resume context — same caveat
  as CLI resume); outputs are downloadable but there is no local cwd to pull
  into. A "continue in Pi instead" affordance shows the CLI command
  (`/remote:resume <id>`) — the deep-link philosophy running in both directions.
- **Guard rails:** `requires_action` and budget states surface in the composer
  itself; sending is disabled with an explanation when the key lacks `write` or
  the session is terminal.

---

## 6. Architecture & repo organization

### Stack

- **Vite + React + TypeScript** — SPA behind auth; no SSR framework.
- **TanStack Router** (typed routes end-to-end) + **TanStack Query** (server
  state, SSE-driven invalidation).
- **`@pi-managed/contracts` consumed directly** — one typed API client, zod
  runtime validation of responses. The frontend cannot drift from the wire
  contract without a type error. This is the project's biggest hygiene asset.
- Deliberately little else. No Redux, no component library, no CSS framework
  (design tokens + CSS modules or vanilla-extract — decide in phase 1 scaffold).

This retires v1's "intentionally dependency-free" constraint — deliberately: a
multi-persona app with forms, streams, and ~15 resource types is unmaintainable in
framework-less JS. The constraint made sense read-only; it doesn't now.

### Package layout

Evolve `packages/web-console` in place (keeps the `/console` mount and workspace
wiring):

```
packages/web-console/
  src/
    api/          # typed client over @pi-managed/contracts: fetch, SSE, errors
    features/     # one folder per domain, mirroring backend src/api/ and
      sessions/   # contracts/src/ 1:1: sessions, agents, environments, vaults,
      agents/     # jobs, webhooks, memory-stores, files, skills, tenant,
      ...         # onboarding. Each co-locates routes + components + queries
                  # + tests.
    components/   # owned design system primitives (§4)
    lib/          # auth/session, mode config, formatting, shared hooks
    app/          # router root, sidebar shell, providers
```

**The 1:1 mirror is the navigation contract:** a developer who knows
`backend/src/api/sessions.ts` finds `contracts/src/session.ts` and
`web-console/src/features/sessions/` without a map. CONVENTIONS.md file-size
limits apply per feature file; vitest + Testing Library per feature; the existing
build-smoke pattern (assert no mutating verbs reachable without scope) carries
forward adapted.

---

## 7. Security

- **No API key in JavaScript-readable storage.** Phase 1 adds a cookie-session
  exchange (the one significant backend change): paste the key once →
  `POST /console/session` validates it and stores it server-side keyed to an
  `HttpOnly; Secure; SameSite=Strict` cookie → subsequent console calls ride the
  cookie; the browser JS never holds the key again. `DELETE /console/session` =
  sign out. This follows current OWASP/IETF browser-app guidance (BFF pattern) and
  replaces v1's `localStorage` approach, which is the documented anti-pattern.
  Sessions are short-lived server-side (configurable TTL, sliding).
- **CSRF:** the state-changing console endpoints under cookie auth require a
  custom header (double-submit or `Sec-Fetch-Site` check) — decided in the
  phase-1 backend design note.
- **CSP on the serve hook:** `default-src 'self'`, no inline script, no external
  hosts. Everything bundled.
- **Secrets write-only end-to-end** (DP-8); the UI never echoes a secret after
  submit, matching the API's own guarantee.
- **Destructive actions** follow DP-7 (typed confirmation + consequence language).
- **Scope nudges** follow DP-8; the console displays the active key's scopes and
  a downgrade suggestion when over-privileged.
- **Public config endpoint** (§2) leaks only `mode` + `onboardingEnabled`.

---

## 8. Backend changes required (small, enumerated)

1. `GET /console/config` — public mode/onboarding flags (§2).
2. `POST /console/session` + `DELETE /console/session` — key⇄cookie exchange
   (§7), plus session store (Postgres table or signed encrypted cookie —
   phase-1 design note decides).
3. CSP + security headers added to `createConsoleServeHook`
   (`packages/backend/src/api/console.ts`).
4. *(Phase 2)* client extension prints console deep links; optional
   `/remote:console` command (`packages/client-extension`).

Everything else is consumed as-is from `/v1`.

---

## 9. Phasing

Each phase is a usable increment with explicit verification.

**Phase 1 — Foundation & parity.**
Scaffold stack; design tokens + core components; typed contracts client;
cookie-session auth + config endpoint + CSP (backend); Sessions list, session
detail (Trace/Usage), Home skeleton; mode-aware sign-in.
*Verify:* parity tests against the v1 console's behaviors pass; performance
budget (DP-10) measured in CI; the vanilla app is retired only when parity is
green.

**Phase 2 — Pi-coder surface (U2–U8).**
Live SSE trace tail; steer / interrupt / answer `requires_action` (write scope);
Outputs tab; fork; Tree tab; memory stores; job run inspection; favicon status
(DP-11); extension deep links.
*Verify:* a delegated session can be watched live, paused on `always_ask`,
answered from the console, and its outputs downloaded — end-to-end test against a
dev backend.

**Phase 3 — Tenant-admin surface + onboarding (T1–T8).**
Agents (versioned, archive flow with DP-7), environments (incl. worker keys,
work-stats, drain), vaults/credentials (DP-8), API keys, webhooks (+ test),
jobs CRUD, tenant/quota dashboard (DP-14); SaaS signup page + first-run checklist
(DP-12); solo/team mode copy variants.
*Verify:* every T-journey step achievable in the console without curl; secrets
never appear in any response fixture; axe-core accessibility pass (DP-13).

**Phase 4 — Continue from any browser (§5a).**
Conversation tab on session detail: composer, turn lifecycle (queued follow-ups,
interrupt), conversation rendering seeded from `GET …/messages`, wake-on-message
for idle sessions, mobile-usable layout, "continue in Pi instead" hand-back.
Builds entirely on phase-2 event/SSE plumbing; no new backend surface.
*Verify:* on a machine with no Pi installed, an idle session can be woken,
conversed with across multiple turns (including one `requires_action` answer and
one interrupt), and handed back to the CLI with state intact.

**Phase 5 — Commercialization facilities (§2a).**
Backend: ledger + tenant lifecycle (`trial/active/suspended`), documented
metering-event schema with idempotency keys, usage-over-time endpoints
(also feeds the phase-3 cost dashboard — build the endpoints there, the ledger
here), balance-threshold webhook events, `packages/billing-adapter` skeleton
with the Stripe reference implementation (Checkout top-ups + payment webhook →
credit balance). Console: Home balance element, Billing settings section,
low-balance/suspended states, signup trial-grant copy.
*Verify:* with the adapter configured against Stripe test mode — signup grants
trial balance; a session drains it; `balance_low` fires; top-up via Checkout
credits the ledger exactly once under webhook replay (idempotency test);
auto-charge fires on threshold, respects its daily/monthly caps, and disables
itself (with notification) after consecutive failures; suspended tenant can
read everything and start nothing. Without an adapter configured, saas mode
hides money buttons and nothing else breaks.

**Later — decided separately.** Platform-admin surface (recommendation: don't —
Grafana + shell remain that persona's tools). Revisit only with a real
platform-admin auth design.

**Documentation per phase (not after):** `packages/web-console/README.md`,
`docs/console.md` (this document, moved and maintained), `docs/api-reference.md`
console section, `user-journeys.md` cross-references, `deploy.md`
(`CONSOLE_MODE`).

---

## 10. Decisions (all resolved 2026-07-17)

1. **Console-session storage: Postgres table.** Instant server-side sign-out
   and key-revocation kill, sliding TTL as a column update, future "list
   active console sessions"; matches the Postgres-as-source-of-truth pattern.
2. **CSS: CSS Modules + custom properties** for design tokens. Zero added
   dependencies (Vite built-in); theming = swapping `:root` values.
3. **Session TTL defaults (sliding; `CONSOLE_SESSION_TTL` overrides):**
   solo 30 d, team 7 d, saas 24 h.
4. **`/readyz` health widget: solo/team only.** SaaS tenants get no in-product
   infra status; a public status page is the right SaaS channel later.
5. **Phase-4 mobile: responsive-only.** No PWA/service worker (interacts with
   CSP and cookie auth); revisit on demand.
6. **Payment engine: Stripe** for the reference adapter. A merchant-of-record
   switch stays possible via the same seams; note Stripe leaves us merchant
   of record for tax.
7. **Pricing unit: compute absorbed into the marked-up model-spend rate.**
   One price line. Guardrails against compute-heavy/token-light abuse:
   concurrent-sandbox quotas + idle-session caps. Revisit only if real usage
   shows margin leaks.
8. **Trial: $5, activates on email verification.** Existing per-IP signup
   rate limits stay; verification is the added identity friction.

---

## 11. Research sources

Auth/security: [Curity SPA best practices](https://curity.io/resources/learn/spa-best-practices/) ·
[IETF OAuth for browser-based apps](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-browser-based-apps) ·
[Duende BFF](https://duendesoftware.com/blog/20210326-bff) ·
[Auth0 BFF](https://auth0.com/blog/the-backend-for-frontend-pattern-bff/)
— Stack: [Vercel: TanStack Router vs React Router](https://vercel.com/i/tanstack-router-vs-react-router) ·
[Vercel: Svelte vs React](https://vercel.com/i/svelte-vs-react)
— Dashboard/console UX: [Vercel dashboard redesign](https://vercel.com/blog/dashboard-redesign) ·
[Vercel dashboard performance](https://vercel.com/blog/how-we-made-the-vercel-dashboard-twice-as-fast) ·
[Stripe merchant dashboard](https://mattstromawn.com/projects/stripe-dashboard/) ·
[Eleken: "Make it like Stripe"](https://www.eleken.co/blog-posts/making-it-like-stripe) ·
[FlowmazeUX](https://flowmazeux.com/saas-dashboard-design-best-practices/) ·
[GitNexa](https://www.gitnexa.com/blogs/saas-dashboard-ux-patterns)
— Keys/DX: [Stripe key best practices](https://docs.stripe.com/keys-best-practices) ·
[Moesif Stripe DX teardown](https://www.moesif.com/blog/best-practices/api-product-management/the-stripe-developer-experience-and-docs-teardown/)
— IA: [Productboard main navigation](https://support.productboard.com/hc/en-us/articles/39463654566931-Main-navigation-elements) ·
[Productboard teardown](https://alexdebecker.substack.com/p/product-teardown-productboard)
— Traces: [LangSmith observability](https://www.langchain.com/langsmith/observability) ·
[Langfuse tracing](https://langfuse.com/docs/observability/overview)
— CLI-first: [Fly.io logbook](https://fly.io/blog/logbook-2022-06-23/) ·
[fly dashboard](https://fly.io/docs/flyctl/dashboard/)
— Onboarding: [Userpilot signup flow](https://userpilot.com/blog/saas-signup-flow/) ·
[designrevision onboarding](https://designrevision.com/blog/saas-onboarding-best-practices)
— Commercialization/Stripe: [Stripe SaaS integration](https://docs.stripe.com/saas) ·
[Stripe Entitlements](https://docs.stripe.com/billing/entitlements) (surveyed; not needed under the no-plans model) ·
[Stripe metered billing 2026](https://www.buildmvpfast.com/blog/stripe-metered-billing-implementation-guide-saas-2026) ·
[Credyt usage-based billing](https://credyt.ai/blog/stripe-usage-based-billing-how-it-works) ·
[designrevision Stripe integration](https://designrevision.com/blog/saas-stripe-integration) ·
[Customer Portal](https://docs.stripe.com/customer-management/integrate-customer-portal)
