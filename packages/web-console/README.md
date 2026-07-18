# `@pi-managed/web-console` — Pi Console

The browser surface over the public `/v1` API, served by the backend at
`/console` (spec: `docs/console-spec.md`; design: `docs/console.md`). Phase 1
(WP-C1.1–C1.8 — sign-in, app shell, sessions read surface), phase 2
(WP-C2.1–C2.6 — live SSE trace, steer/interrupt/confirm, Tree/Outputs/Fork,
jobs + memory stores, ambient status, CLI deep links), phase 3
(WP-C3.0–C3.8 — the tenant-admin management surfaces: agents, environments,
vaults, API keys, webhooks, jobs lifecycle, tenant dashboard, health widget,
files/skills, saas signup + first-run), and phase 4 (WP-C4.0–C4.3 —
continue from any browser: Conversation view, composer + turn lifecycle,
memory version restore, phone-width layout) are complete, each gated by its
conformance suite (`test/phase1-gate/` … `test/phase4-gate/`). The v1
read-only vanilla-JS console this package used to hold was retired in
WP-C1.8 (see git history).

The console consumes ONLY the public `/v1` API plus the two console-support
endpoints, `GET /console/config` and `/console/session` — and, solo/team
only, the two PUBLIC health probes `/healthz`/`/readyz` (C§5.1) — (parity
rule, console-spec §1.2): anything the console can do, `curl` can do. This
is gate-enforced (`test/phase1-gate/api-surface.gate.test.ts`, extended for
the streaming transport by `test/phase2-gate/api-surface.gate.test.ts`).

## Stack

- **Vite + React + TypeScript** — SPA, no SSR.
- **TanStack Router** — code-based routes with `basepath: "/console"`; every
  route component is a lazy `*.lazy.tsx` module (route-level code splitting,
  console-spec §12.1).
- **TanStack Query** — server state; provider wired in `src/main.tsx`.
- **CSS Modules + custom-property design tokens** (decided, `docs/console.md`
  §10.2 — zero styling dependencies). Tokens are CSS custom properties on
  `:root` in `src/styles/tokens.css`; components import `*.module.css` and
  consume tokens only. Light is default, dark comes from
  `prefers-color-scheme`, and an explicit `data-theme="light|dark"` attribute
  on `<html>` (persisted per-browser, `src/lib/theme.ts`) overrides the OS.
- No component library, no CDN assets ever — the backend sends
  `default-src 'self'` CSP on all `/console*` responses, so everything must
  be bundled (no inline scripts either). Gate-enforced: the built `dist/`
  references no external host.

## Layout

```
index.html            Vite entry (root of the package, Vite convention)
src/
  main.tsx            entry: theme bootstrap, Query + Router providers
  api/                typed API client over @pi-managed/contracts (see
                      src/api/README.md): fetch wrapper, hooks, query keys
  app/                router (route tree, basepath), shell layout (sidebar),
                      auth gate + context, providers
  features/<family>/  one folder per resource family, mirroring
                      backend/src/api and contracts/src 1:1 (routes +
                      components + queries + tests co-located); auth/ holds
                      the sign-in screen
  lib/                shared utilities (theme, scopes, …)
  styles/             tokens.css (design tokens) + global.css (base styles)
  ui/                 design-system components (see src/ui/README.md)
  test/               vitest jsdom setup + shared test fakes/helpers
test/
  phase1-gate/        phase-1 conformance gate, console-spec §13 (see Tests)
  phase2-gate/        phase-2 conformance gate: streaming + W3/W4 journeys
  phase3-gate/        phase-3 conformance gate: axe on every route, secret
                      scan, scope/mode matrices, W8–W16 journey coverage
                      (see its README for the coverage table)
  phase4-gate/        phase-4 conformance gate: W5 phone flow (DOM/JS half),
                      responsive-CSS + no-PWA static pins, lazy-chunk pin,
                      @kvm continue-anywhere flow (see its README for the
                      manual residue)
scripts/
  check-budget.mjs    perf-budget gate, runs as part of `pnpm build`
```

## Routes

Code-based route tree in `src/app/router.tsx` (`basepath: "/console"`; every
component is a lazy `*.lazy.tsx` chunk). Routes stay registered for every
scope — deep links must resolve and the backend enforces (§6.4); the sidebar
merely hides what a key cannot use.

| Route | Screen | Since |
| --- | --- | --- |
| `/` | Home: headline strip (DP-14), `requires_action` (§7.5 — the server-side `?stopReason=` filter, shared with the sidebar badge) + active sessions, per-browser recents/favorites (spec §7.2); under saas + onboarding, an incomplete W8 first-run checklist surfaces as a card linking back to `/signup` (DP-12). In saas the **balance strip** (§11.8, W15) renders above the metrics: balance + burn sparkline + "lasts ~N days at current rate" (a runway day-count projection, not money), plus the unverified/low-balance/suspended banner (one fixing action). Renders nothing in solo/team or when billing isn't enrolled | WP-C1.7 / WP-C2.2 / WP-C3.8 / WP-C5.4 |
| `/sessions` | Sessions list: one list (DP-4), columns per §7.3 (cost = the `usage.usdCost` rollup, USD), status/agent/environment filters, cursor pagination | WP-C1.7 / WP-C2.2 |
| `/sessions/:id` | Session detail: DP-1 header (status + stop reason, agent@version, environment, cost) with the **Fork** action (W6: `write` scope, disabled-with-reason under `read`; success links the new session and shows the CLI follow-up `/remote:resume <id>`, §1.4), then the W4 interaction panel (see "Steer, interrupt, confirm" below). Tabs per §7.3 — Trace (default), Tree (fork lineage from `forkedFromSessionId` + the JSONL log tree from `GET …/tree`), Usage, Outputs (file list + cookie-riding `<a href>` downloads; idle-only per the API — a busy session gets one line of microcopy), Conversation (see "Conversation view" below: transcript + the WP-C4.2 composer — send/wake, mid-turn queue, interrupt, requires_action inline, hand-back). The deep-link target the CLI prints (§1.4) | WP-C1.7 / WP-C2.2 / WP-C2.3 / WP-C4.1 / WP-C4.2 |
| `/jobs` | Jobs list (§9.4, W7): DP-1 columns — name, schedule (human phrase + raw cron/tz), status, last-run outcome, next fire (computed client-side, `src/features/jobs/schedule.ts`) — plus **New job** (`write`, disabled-with-reason §6.1): form per contracts `JobCreate` with agent/environment pickers, cron+tz validated client-side (same parse rules as the backend; server stays authority) and a live next-fire preview | WP-C2.4 / WP-C3.5 |
| `/jobs/:id` | Job detail: DP-1 facts, **pause reason front and center** when paused (auto-pause cause per §17.4/§17.6), definition, runs history with per-run session links, manual **Run now** (`write` scope; disabled-with-reason under `read`, §6.1), and the `write` lifecycle — **Pause/Unpause** (§17.5: missed runs not backfilled) and **Archive** behind a DP-7 typed confirmation (terminal — the backend hides archived jobs from every read, so the flow returns to the list) | WP-C2.4 / WP-C3.5 |
| `/resources` | Resources SECTION LAYOUT (§7.1 contextual submenu): persistent sub-navigation over environments · vaults · memory stores · files · skills, family overview on the index | WP-C2.4 / WP-C3-prep |
| `/resources/environments` | Environments list (§9.2, W10/W12): name/id/type/status columns, server-side `?status=` filter, **Create environment** (`write`, disabled-with-reason §6.1) — type + cloud image/network policy with the DP-6 one-liners (`unrestricted` still can't reach the host or cloud metadata; `limited` is default-deny + named hosts) chosen at decision time | WP-C3.2 |
| `/resources/environments/:id` | Environment detail: DP-1 facts, then per type — `cloud`: image, resources, network policy with its one-line explanation (+ the explicit allow list when `limited`); `self_hosted` (W12): live `work-stats` (depth, pending, oldest queued, workers polling; polled every 10 s while visible), **worker keys** listed from `/v1/api-keys` by the `self_hosted_worker:<envId>` scope marker + **Mint** with the raw key shown EXACTLY once behind copy-and-confirm (DP-8; the page repeats the W12 rule — the only key that belongs on a worker host), and **drain** via `work-stop` where a clean stop comes first and `{force: true}` is the explicit SECOND step behind a DP-7 typed confirmation. Lifecycle: **Edit** (PATCH — not versioned, the dialog says so), **Archive** (terminal) and **Delete** (hard) behind DP-7 typed confirmations | WP-C3.2 |
| `/resources/vaults` | Vaults list (§9.3, W11): DP-1 columns + **New vault** (`write`, disabled-with-reason §6.1); the intro and empty state teach the concept and the CLI path (`/remote:vault create`, DP-5) | WP-C3.3 |
| `/resources/vaults/:id` | Vault detail: facts, the **fail-closed** `model_provider_key` rule + ~60 s rotation propagation stated on the page (DP-6), credentials grouped by category — records only, never a secret value (C§13). Per-category **Add** dialog with a write-only secret field (`type=password`, cleared from state on submit/close — the sign-in key handling), live **Validate** (§12.5 outcome rendered inline), **Delete** credential and **Archive vault** behind DP-7 typed confirmations naming the real consequences (secret purged + key stays reserved; archive cascade) | WP-C3.3 |
| `/resources/memory-stores` | Memory stores list (§9.5, read-only this phase) | WP-C2.4 |
| `/resources/memory-stores/:id` | Store detail: facts + instructions, Memories tab (per-memory content on demand — JSON in the JsonViewer, else plain text), Version history tab (audit trail; open a version for its fields; Restore per non-redacted version — write scope, plain confirm dialog: the backend copies the content server-side into a NEW head version, WP-C4.0b) | WP-C2.4, WP-C4.0b |
| `/resources/files` | Files (§9.5): list (name · id · content type · size · owning-session link · created, cursor pagination), row-activated detail panel fetched on demand (DP-2 — no detail route, §9.5 is list-first) with metadata and a cookie-riding `<a href download>` to `GET /v1/files/:id/content`, and **Delete** (hard, `write` scope per the backend's method→scope guard; disabled-with-reason §6.1) behind a DP-7 typed confirmation. Uploads are multipart and API-only — the empty state + microcopy teach the `curl` path (DP-5) | WP-C3.6 |
| `/resources/skills` | Skills (§9.5): list with the server-side `?type=` filter (prebuilt/custom), row-activated panel with the version history (`GET /v1/skills/:id/versions`), **Delete** (hard, `write` scope, DP-7 dialog naming the version count). No content endpoint exists for skills — detail is metadata + versions, "per API". Uploads are multipart and API-only (DP-5 empty state) | WP-C3.6 |
| `/agents` | Agents list (§9.1, W10): columns name · version · status · updated, exact `?name=` filter, cursor pagination. **New agent** (`write`; disabled-with-reason otherwise, §6.1) opens the create dialog — the body follows contracts `AgentCreate` exactly and the validation messages ARE the zod issues, mapped to the field their path names | WP-C3.1 |
| `/agents/:id` | Agent detail: DP-1 facts + the definition rendered readably — model, prompt, and the per-tool permission-policy table with one line of microcopy per policy (the W16 governance view) — version history browsable (each immutable config expands in place), deep link to `/sessions?agentId=…`. **Edit** → PATCH, with the §9.1 copy stated plainly: saving creates version n+1, running sessions keep theirs, omitted fields keep their previous value. **Archive** (terminal) → DP-7 typed confirmation naming the real consequence: the count of scheduled jobs it auto-archives (computed client-side by walking `/v1/jobs` — the API has no `?agentId=` job filter; degrades to "at least N" past the page cap and to countless-but-honest copy if the read fails) | WP-C3.1 |
| `/settings` | Settings SECTION LAYOUT (§7.1): persistent sub-navigation over API keys · Webhooks · Tenant · Billing[saas] · Health[solo/team]. MODE RULES (§5): Health only in solo/team; Billing only in saas (WP-C5.4). The index reprints the Pi-extension install instructions (W8 step 3 — the canonical `pi install` command + connect steps, every mode) | WP-C3-prep |
| `/settings/api-keys` | API keys (§9.7, W9): list with scope chips (`admin` visually loud — an over-broad key is visible at a glance; worker keys show their environment binding), **Issue key** (`admin`, disabled-with-reason §6.1) with scopes **opt-UP from `["read"]`** (read is the locked floor — backend scope matching is exact, write does not imply read; write/admin are explicit opt-ins) and the raw key shown EXACTLY once (DP-8 copy-and-confirm; never re-fetchable), **Revoke** behind a DP-7 typed confirmation naming the real consequence — everything on the key stops authenticating immediately, console sessions signed in with it included | WP-C3.4 |
| `/settings/webhooks` | Webhooks (§9.8, W13): register with an event-type picker enumerated from the contracts `WebhookEventType` enum, `whsec_` signing secret shown once (DP-8), per-endpoint **Send test** (`write`, like every webhook mutation) with inline delivery state (W13: test before trusting), auto-disabled endpoints surfaced in a prominent alert with the only re-enable path the API offers (delete + re-register — mints a NEW secret), delete behind a DP-7 typed confirmation | WP-C3.4 |
| `/settings/tenant` | Tenant dashboard (§9.9, W14 — all modes, §11.2): DP-1 facts (name, plan, copyable tenant id), **quota-vs-limit** table pairing every `quotaUsage` figure with its plan ceiling (the backend's own `domain/quota` mapping), **spend over time** from `GET /v1/tenant/usage` (day/month granularity toggle, ui-kit Sparkline trend, bucket table), **breakdowns** by agent (ids deep-link to agent detail) and by `metadata.userId` (null labeled), and client-side **CSV export** of the fetched rows — a Blob download, values digit-for-digit as the API returned them (§11.9: no client-side money math) | WP-C3.6 |
| `/settings/billing` | Billing (§11.8–11.9, W15 — saas ONLY): balance + lifecycle chip (`GET /v1/tenant/billing`), the unverified / low-balance / suspended banners (DP-9, one fixing action), **ledger history** table (grants/top-ups/debits/adjustments from `GET …/ledger`, cursor-paginated), and — present ONLY when a payment adapter is configured (§11.8) — **Top up** and **Receipts & payment method** (link-outs that redirect to an adapter-issued hosted URL; the card is entered there, never in the console) plus the **auto-charge** controls (toggle off by default; threshold/amount, visible daily+monthly caps, last-charge, auto-disable notice). With no adapter the money controls are ABSENT and everything else works. The console NEVER computes money (§11.9): every figure is the API's `*Usd` verbatim; the only derived number is the Home runway day-count. In solo/team the route resolves but states it is a saas facility and fires NO billing probe | WP-C5.4 |
| `/settings/health` | Backend health (§5.1, solo/team ONLY — decision 4): liveness from public `/healthz`, per-dependency readiness from `/readyz` (the 503 `not_ready` body renders its checks + details). In saas the route still resolves (§1.4) but states the decision and fires NO probe | WP-C3.6 |
| `/signup` | PUBLIC route (renders outside the auth gate; mode-gated at render on `/console/config` — §5.3, gated off unless saas + `onboardingEnabled`): the W8 flow — tenant name + admin email (NO payment details, §9.6) → admin key shown EXACTLY once behind copy-and-confirm → automatic sign-in through the console-session flow → the DP-12 first-run checklist (model key → agent → first session; each step deep-links to the real surface and completion is detected via the real APIs). In a billing-enabled deployment (§11.1) the checklist prepends the unverified-trial notice + resend and BLOCKS "start a first session" until the email is verified (an unverified trial is fail-soft suspended). A signed-in visit shows the checklist again while incomplete; a repeat sign-up for a known email gets no key ("ask your admin", R0.3). The sign-in screen links here in saas mode | WP-C3.7 / WP-C5.4 |
| `/verify-email` | PUBLIC route (§11.1, WP-C5.4): the trial-verification email links here with `?token=…`; posts it to the public `POST /v1/onboarding/verify-email`, which activates the pending $5 trial grant EXACTLY once and moves the tenant `trial → active` (idempotent under replay). A missing/expired token renders the DP-9 failure with a path back to the console | WP-C5.4 |

Recents/favorites are client-side per-browser state in localStorage
(`pi-console.recent-sessions` / `pi-console.favorite-sessions`,
`src/lib/session-shortcuts.ts`) — bookmarks, not key material (§4.1). While a
session is in a non-terminal status its Trace live-tails over SSE (WP-C2.1,
spec §8.1–§8.2): fetch-streaming with `Last-Event-ID` resume, an entries-
polling fallback when SSE is unusable, and a subtle live/polling/ended
indicator that doubles as a polite ARIA live region (§12.2). See
`src/api/README.md` §"Live streaming". While a session detail is on screen,
the tab title and favicon mirror its status (running / completed / failed /
`requires_action` — DP-11, spec §8.3; `src/lib/ambient-status.ts`, applied
from the app shell), so a background tab stays informative (WP-C2.5).

### Steer, interrupt, confirm (WP-C2.2, journey W4)

The session detail mounts an interaction panel between the header and the
tabs (`src/features/sessions/interact-panel.tsx`), posting the three
api-reference inbound events via `POST /v1/sessions/:id/events`
(`src/api/session-events.ts` — CSRF + auto `Idempotency-Key` come from the
client wrapper). It shows for the Trace/Tree/Usage/Outputs tabs but HIDES on
the Conversation tab, where the composer (below) owns interaction — otherwise
both would render a `user.message` input and a Blocking-requests group,
duplicating the landmark (F4):

- **Blocking requests** — a session idle on `stopReason: requires_action`
  renders its pending tool request(s) (tool name + collapsed input, resolved
  from the trace's `session.status_idle.blockingEventIds`) with **Approve /
  Deny** posting `user.tool_confirmation` per blocking event id (§9.5). The
  resumption arrives via the live stream (or the mutation's invalidations)
  and the panel clears.
- **Steering composer** — one small input + Send posting `user.message`.
  Idle-only per the API (`409 session_not_idle` mid-turn), so while running
  the button is disabled with "Interrupt first". Deliberately not the
  phase-4 Conversation view.
- **Interrupt** — while running, one confirm-free `user.interrupt`,
  acknowledged by toast.

Scope rule (§6.1, W4 watch-out): with a `read` key all of these render
disabled **with the reason**, never hidden. `requires_action` also surfaces
globally (§7.5): a count badge on the sidebar's Sessions item plus the Home
section, both fed by one `?stopReason=requires_action` first-page query
(WP-C2.0's filter) polled every 30 s (`REQUIRES_ACTION_REFRESH_MS`,
`src/api/sessions.ts`) and refreshed immediately by any open stream's
`session.status_*` invalidations.

### Conversation view (WP-C4.1 + WP-C4.2, journey W5)

The Conversation tab (`src/features/sessions/conversation-tab.tsx`) is the
console-spec §10.1 conversation-shaped lens on the session — the same record
as the Trace, a different visualization (DP-4). It seeds from
`GET /v1/sessions/:id/messages` (Pi's post-compaction `session.messages`
view; fetcher/hook in `src/api/conversation.ts`): user messages render
right-aligned and distinct, assistant text as markdown-ish plaintext
(pre-wrap paragraphs, fenced ``` blocks monospaced — no markdown dependency),
and tool calls / tool results / thinking as one compact line each with the
full payload one `JsonViewer` click away (`console.md` §5a: the conversation
lens de-emphasizes tool internals). Long transcripts start at the last 100
messages with a show-all control; a fork states in place that its transcript
includes the history shared with its parent up to the fork point (the
`/messages` read serves the shared JSONL tree).

Freshness is honest about the wire (§10.1): stream frames carry trace
entries, never message-shaped data, and the backend syncs the JSONL that
`/messages` reads on every `session.status_idle` transition plus ~30 s
periodic while running. So turn boundaries land immediately — the
detail-page stream invalidates the messages query on `session.status_*`
frames (`src/api/session-stream.ts`) — while mid-turn the tab polls at the
sync cadence (`MESSAGES_SYNC_REFRESH_MS`) and shows a note pointing at the
Trace tab for live per-event output.

**Composer + turn lifecycle (WP-C4.2, W5 steps 2–4).** Below the transcript
sits the composer (`src/features/sessions/conversation-composer.tsx`) — the
"continue from any browser" surface (§10.1–10.4):

- **Send / wake** — submits one `user.message` while the session is idle.
  Server-side that resolves the live runtime (`api/events.ts` →
  `sessionManager.getOrCreate`), cold-waking the session and re-provisioning
  its sandbox on demand; the `202` is acceptance, not a reply, so a
  `role="status"` waking note holds until the `session.status_run_started`
  frame flips the cached status. That frame is only observable because the
  detail-page stream RECONNECTS after the backend's clean close of the idle
  (runtime-less) stream instead of latching `ended` (F1 — cold-wake
  observability, `src/api/stream.ts`); the mutation also invalidates the
  detail so the wake shows fast. A CLI `/remote:resume` wake is seen the same
  way.
- **Mid-turn queue, client-side (C§10.2)** — the backend rejects a mid-turn
  `user.message` with `409 session_not_idle` (ROB-5 — a concurrent turn would
  corrupt the runtime's turn flags), so C§10.2 puts the queue in the console:
  mid-turn submissions become visible chips ("held in this browser tab"),
  rendered honestly — nothing is silently dropped. The queue's home is the
  **session-detail page** (`session-detail.lazy.tsx`), not the composer, so it
  SURVIVES tab switches — the tab strip unmounts inactive panels, and the
  waking note itself recommends the Trace tab (F2). One queued message is
  dispatched per return to idle (more would race the same guard); the flush is
  STATE-driven — idle && !`requires_action` && queue non-empty && no send in
  flight && no prior `409` — never keyed on catching the idle→running→idle
  transition, so a fast turn whose `run_started`+`idle` refetches coalesce into
  a single idle read cannot strand the queue (F3). Chips are removable before
  they send; the flush holds while a `requires_action` decision is pending.
- **Interrupt** — one click in the composer row while a turn runs.
- **`requires_action` in the composer** — the W4 approve/deny panel
  (`blocking-requests.tsx`) renders inline where you would type (§10.2).
- **Resume caveats (§10.3, DP-6)** — one line at the wake moment (while
  idle, gone mid-turn): processes from earlier turns are not preserved,
  outputs download to your machine, there is no local working directory.
- **Hand-back (§10.4)** — "Continue in Pi instead:" with the exact
  `/remote:resume <id>` extension command and one-click copy, shown after a
  non-empty transcript (the DP-5 empty state already teaches the command).
- **Guard rails (§6.1)** — under a `read` key or on a `terminated` session
  every control is disabled *with* the reason, never hidden.

The wake wire contract is proven in
`src/api/__tests__/session-wake.contract.test.ts` (see `src/api/README.md`
for what a real cold wake adds beyond the harness's reach); the composed
end-to-end flow — real cold wake on a microVM, requires_action answer,
interrupt, hand-back state — is the `@kvm` phase-4 gate
(`test/phase4-gate/continue-anywhere.gate.test.ts`).

### Billing & commercialization (WP-C5.4, journey W15, console-spec §11)

Prepaid, single-unit (dollars), **saas mode only** — solo/team self-hosters
are never balance-gated (the gate is the backend's `BILLING_ENABLED`, surfaced
as presentation mode). The console is a thin layer over the backend ledger,
which is the source of truth for balance (§11.3); **the console never computes
money client-side (§11.9)** — it renders the API's already-divided `*Usd`
figures verbatim (`formatUsd` only formats). The one derived number is the Home
runway "lasts ~N days" (`src/lib/runway.ts`) — a *day count*, not money.

- **API** (`src/api/billing.ts`): ledger tier — balance/lifecycle/verification
  (`GET /v1/tenant/billing`; a `404` reads as "no billing"), ledger history
  (`GET …/ledger`), verification resend, verify-email. Adapter tier —
  auto-charge get/update + checkout/portal link-out; `getAutoCharge` doubles as
  the adapter-presence probe (`404 → null`, the single "no adapter" signal).
- **Top up (§11.7/§11.9)**: "Top up" opens the amount dialog
  (`features/settings/top-up-dialog.tsx`); continuing `POST`s
  `/v1/tenant/billing/checkout` with the USD amount and redirects the browser to
  the adapter-issued hosted URL — **the card is entered there, never in the
  console**. The reference (Stripe) adapter issues a fixed-amount page, so an
  amount is required (an omitted amount is a `422`); the dialog always sends one.
  Receipts / payment-method uses the same link-out via `POST …/portal`.
- **Home strip / Settings → Billing**: see the route table above.
- **No-adapter degradation (§11.8)**: the checkout/portal/auto-charge routes are
  served only when a deployment fronts `packages/billing-adapter` with the thin,
  SDK-free backend proxy (`BILLING_ADAPTER_URL` + `BILLING_PROVISION_TOKEN`).
  **Absent that proxy they `404` and the console shows the no-adapter state:
  money controls absent, balance/history/verification and everything else still
  work.** Both paths are pinned against the real backend by
  `src/api/__tests__/billing.contract.test.ts`: the no-adapter degradation on a
  default backend, and the WITH-adapter fetchers (auto-charge get/patch,
  checkout/portal URL issuance, the amount-required `422`) against the real proxy
  pointed at a fake adapter — only the payment engine is faked, at the adapter's
  own seam.
- **Trial verification (§11.1)**: the $5 trial activates only on email
  verification; the console surfaces the unverified state + resend on Home,
  Billing, and the first-run checklist, and verification gates "start a first
  session". `/verify-email?token=…` activates it (idempotent).

### Responsive design (WP-C4.3, console-spec §10.5)

The console is **responsive-only** — usable at a phone-width viewport
(~375 px), with **no PWA surface** by decision (`console.md` §10.5: a
service worker interacts with the §3.4 CSP and the §4 cookie auth; no
manifest, no service worker — pinned by `test/phase4-gate/no-pwa.gate.test.ts`).
Mechanics, all CSS (design tokens + media queries in the CSS modules; one
breakpoint, 720 px; no layout library):

- **Sidebar → top bar + drawer** (`src/app/shell.tsx` + `shell.module.css`):
  below the breakpoint the sidebar becomes a top bar whose nav + session
  block open behind a `Menu` disclosure button (`aria-expanded` /
  `aria-controls`; keyboard-operable; following a nav link closes it). On
  desktop the button is `display: none` and the drawer is always visible.
- **Tables scroll in place** (`src/ui/table.tsx`): every `Table` renders
  inside a focusable, labelled scroll container (`overflow-x: auto`,
  `role="group"` + `tabIndex=0` so keyboard users can scroll it) — dense
  tables scroll inside their own region, the page never scrolls
  horizontally. The tablist (`src/ui/tabs.module.css`) scrolls the same way.
- **Composer at phone width** (`conversation.module.css`,
  `interact-panel.module.css`): the message field takes the full row (a
  usable on-screen-keyboard target); Send/Queue and Interrupt wrap below.
- **Dynamic viewport units**: full-height screens (shell, sign-in, signup,
  auth boot) and the dialog's height cap use `dvh` with a `vh` fallback, so
  the on-screen keyboard and mobile URL bars do not push controls off
  screen. Toasts cap at `min(24rem, 100vw - margins)`.
- **Header wrapping**: the session-detail title row and meta rows
  `flex-wrap` instead of overflowing.

The viewport meta (`width=device-width, initial-scale=1`) has shipped in
`index.html` since phase 1 and is pinned by the phase-4 gate. What jsdom can
honestly verify (chrome exists and functions at 375 px, no fixed width in
any shipped stylesheet exceeds 375 px, tables are wrapped) is automated in
`test/phase4-gate/`; real-reflow checks are the manual item in
`test/phase4-gate/README.md`.

## Authentication

Console auth is a **cookie-backed console session** (console-spec §4),
implemented backend-side in `packages/backend/src/api/console-session.ts`:

- **Sign-in** (`src/features/auth/sign-in.tsx`): the app fetches
  `GET /console/config` first and shows mode-appropriate copy (solo/team/saas,
  console-spec §5). The pasted API key exists only in transient component
  state and the `POST /console/session` request body; the backend exchanges
  it for an `HttpOnly; Secure; SameSite=Strict` cookie the JS can never read.
  **No key material ever touches `localStorage`/`sessionStorage`** (§4.1 —
  enforced by `src/app/auth-flow.test.tsx` and, at gate level,
  `test/phase1-gate/key-storage.gate.test.ts`).
- **Bootstrap** (`src/app/auth.tsx`): on boot the app calls
  `GET /console/session`; 401 renders sign-in, success hydrates the auth
  context `{ scopes, tenant, expiresAt }` (`useAuth()`). Sign-out is
  `DELETE /console/session` + a full query-cache reset.
- **CSRF**: every mutating request carries `X-Console-Csrf: 1`
  (`src/api/client.ts`, §4.5) — the backend rejects cookie-authed mutations
  without it, so a cross-site form post can't ride the cookie.
- **Scope-variant UI** (§6): the sidebar shows exactly the §7.1 sections the
  key's scopes can use (`src/app/nav.ts` — `read` browses everything except
  Settings, which is admin-only management); read-only sessions are badged
  "browsing read-only"; admin-scoped sign-ins get a one-time least-privilege
  nudge whose dismissed flag (a preference, not a secret) is
  `pi-console.admin-nudge-dismissed` in localStorage. Hiding is UX only —
  the backend remains the sole enforcer (§6.4).

## Dev workflow

The backend has no `dev` script — build it once, then run the compiled
server (docs/deploy.md §5 "Boot" is the full environment reference):

```sh
docker compose up -d postgres        # the stateful deps (podman compose works too)
pnpm --filter @pi-managed/backend build
DB_URL=postgres://pi:pi@localhost:5432/pi \
OBJECT_STORE_ROOT=./data/objectstore \
SANDBOX_RUNTIME=disabled \
ALLOW_EPHEMERAL_VAULT_KEY=true \
PORT=3000 \
node --enable-source-maps packages/backend/dist/main.js
```

(`SANDBOX_RUNTIME=disabled` unless the host has `/dev/kvm` + microsandbox;
`ALLOW_EPHEMERAL_VAULT_KEY=true` is the dev-only escape hatch — without it
the boot refuses to start when no `VAULT_KEY` is configured. **Never set it
in production.**) Then, in another terminal:

```sh
pnpm --filter @pi-managed/web-console dev
```

`vite dev` serves the app at `http://localhost:5173/console/` and proxies
`/v1`, `/console/config`, and `/console/session` to `http://localhost:3000`
(see `vite.config.ts`), so API calls and the session cookie stay same-origin
exactly as in production.

## Build + performance budget

```sh
pnpm --filter @pi-managed/web-console build
```

Runs `vite build` (base `/console/`, output `dist/` — the directory the
backend serve hook `packages/backend/src/api/console.ts` serves) and then
`scripts/check-budget.mjs`, which fails the build if the initial JS (entry
chunk + statically imported chunks, as referenced by `dist/index.html`)
exceeds **200 KB gzipped** (console-spec §12.1, CI-enforced). Lazy route
chunks are excluded — keep route components in `*.lazy.tsx` modules.

## Tests

`pnpm --filter @pi-managed/web-console test` — vitest with two projects
(`vitest.config.ts`):

- **console** — the app suites under `src/`: jsdom + Testing Library
  (+ `vitest-axe` on every UI component). Seam rule per `CONVENTIONS.md`
  applies: API-client/contract tests (`src/api/__tests__/`) run against the
  real in-process backend — testcontainers Postgres + the real Fastify app
  over real HTTP — never a stubbed `fetch`.
- **conformance-gate** — the per-phase conformance gates (console-spec §13),
  run alone with `pnpm --filter @pi-managed/web-console test:gate` (mirrors
  the backend's `test/phase1-gate/` pattern; extended per phase, never
  trimmed — one single-worker vitest project for both dirs so the files that
  rebuild `dist/` and the files that read/serve it never interleave).

  `test/phase1-gate/`:
  - §1.2 `api-surface.gate.test.ts` — static scan: the only fetch sites are
    the sanctioned transports `src/api/client.ts` + `src/api/stream.ts`
    (§8.1 fetch streaming, WP-C2.1) + `src/api/health.ts` (the C§5.1 probe
    transport, WP-C3.6); every endpoint literal is `/v1/*`,
    `/console/{config,session}`, or `/healthz`/`/readyz`; the built `dist/`
    references zero external hosts (§3.4 static half).
  - §3.4 + §4.5 `console-headers.gate.test.ts` — against the REAL backend
    serving the built `dist/`: CSP/nosniff/no-referrer on every `/console*`
    response shape; cookie-authed mutation without `X-Console-Csrf` → 403;
    the session cookie is `HttpOnly`.
  - §4.1 `key-storage.gate.test.ts` — after a full sign-in, no key material
    in any JS-readable storage.
  - §6.1 `scope-matrix.gate.test.ts` — each scope sees exactly its surfaces.
  - §12.1 `perf-budget.gate.test.ts` — fresh production build passes the
    budget check.

  `test/phase2-gate/` (real-backend files reuse the shared collaborators in
  `src/api/__tests__/collaborators.ts`):
  - §8.1 `stream-resume.gate.test.ts` — REAL backend: connection killed
    mid-stream → `Last-Event-ID` resume completes the position ladder with
    no missed and no duplicated entries (§13 conformance item).
  - W3+W4 `journey.gate.test.ts` — REAL backend, one open stream: delegate →
    watch live → hit `always_ask` (`requires_action`) → approve from the
    console (cookie + CSRF + idempotency) → resumption observed → outputs
    listed and downloaded over the bare cookie.
  - §7.5 `requires-action-surfacing.gate.test.ts` — one render shows the
    waiting sessions on BOTH the sidebar Sessions badge and the Home
    section, fed by the server-side `?stopReason=` filter.
  - §1.2 `api-surface.gate.test.ts` — positive control: the allowlist scan
    actually sees the stream transport's `/v1` endpoint literals.
  - §12.1 `perf-budget.gate.test.ts` — budget still green with every
    phase-2 chunk; each phase-2 screen stays a lazy chunk outside the
    initial JS set.

  `test/phase3-gate/` (WP-C3.8 — see `test/phase3-gate/README.md` for the
  full table incl. the W8–W16 journey-coverage matrix and its declared gaps):
  - §12.2 `axe-routes.gate.test.ts` — EVERY route the router registers
    (enumerated programmatically, so new routes cannot dodge it) renders
    axe-clean with representative data; keyboard spot checks on the admin
    tables/dialogs/typed confirmations.
  - §9.3 `secret-scan.gate.test.ts` — sentinel secrets driven through the
    vault/API-key/webhook/signup flows never survive in the DOM; static scan
    for real-looking credential literals anywhere in the package.
  - §6.1 `scope-matrix.gate.test.ts` — the Resources/Settings submenus are
    exact sets per scope and mode; admin mutations on browsable sections
    disable WITH a reason.
  - §5 `mode-matrix.gate.test.ts` — health solo/team-only (saas fires ZERO
    probes), signup saas+onboarding-only.
  - `journey-coverage.gate.test.ts` — the README coverage table's test
    pointers are asserted to still exist verbatim.

  `test/phase4-gate/` (WP-C4.3 — see `test/phase4-gate/README.md` for the
  manual residue):
  - §10.5 `phone-viewport.gate.test.ts` — the W5 path (drawer chrome →
    session → Conversation → composer send) renders and functions at a
    375-px viewport; DOM-structural overflow smoke on the key routes (no
    inline widths past the viewport; every table inside its focusable
    scroll container).
  - §10.5 `no-pwa.gate.test.ts` — responsive-only pin: no manifest, no
    service-worker registration in `dist/` or `src/`; the viewport meta
    ships; no stylesheet in the build forces an absolute width > 375 px.
  - §12.1 `perf-budget.gate.test.ts` — the conversation surface stays inside
    the lazy `session-detail.lazy` chunk graph (pinned by its §10.4
    hand-back copy), never in the initial JS set.
  - Phase-4 gate flow `continue-anywhere.gate.test.ts` (`@kvm`) — REAL
    `createManagedApp` + real Postgres + the REAL `MicrosandboxProvider`:
    cold wake on a real microVM, a requires_action block answered `allow`
    through the real permission gate, an interrupt, and the synced JSONL
    holding the whole multi-turn conversation for `/remote:resume` — all
    driven through the console's own client over cookie + CSRF. Skips
    loudly on hosts without `/dev/kvm` + msb (hard failure under
    `PI_REQUIRE_INTEGRATION=kvm`).

Suites that boot the real backend need a container runtime; run them as

```sh
PI_REQUIRE_INTEGRATION=containers pnpm --filter @pi-managed/web-console test
```

so a missing runtime is a hard failure instead of a silent skip (same policy
as the backend suites).
