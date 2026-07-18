# Web Console — User Journeys

> Status: **design reference** — the console's user journeys. Companion to
> [`console-spec.md`](console-spec.md) (normative) and
> [`console.md`](console.md) (design rationale). Follows the format of
> [`user-journeys.md`](user-journeys.md), whose personas it
> reuses; journeys here are the **browser restatements and extensions** of the
> platform journeys (P/T/U numbering refers to that document).

---

## 1. Personas in the console

Personas are key scopes, not account types (spec §6). One console; what you
see is what your key can do:

| Persona | Key scope | Console surface | Modes |
|---|---|---|---|
| **Viewer** (teammate, CI dashboard, curious stakeholder) | `read` | Browse everything, change nothing. Visibly badged read-only | all |
| **Pi coder** | `read`+`write` | Everything above + steer/answer/interrupt, fork, continue-in-browser, trigger jobs | all |
| **Tenant admin** | `admin` | Everything above + agents, environments, vaults, keys, webhooks, tenant, billing | all |
| **Prospective tenant** | none yet | Signup page only | saas |

The platform admin has no console persona (no `/v1` platform-admin API
exists); their surface remains shell + Grafana. Solo-mode users hold all three
roles with one key — the console simply shows everything.

---

## 2. Shared journeys (every persona)

### W1 — Sign in

1. Open `/console`. The app fetches its mode (`GET /console/config`) and shows
   the mode-appropriate sign-in: paste your API key (solo: "how to get your
   first key" help; team: "the key your admin issued you"; saas: sign-in or
   sign-up).
2. Paste the key once → `POST /console/session` → the key is exchanged for an
   `HttpOnly` cookie. **The browser never stores your key**; the page shows
   your tenant name and the key's scopes.
3. Land on Home: recents, favorites, active sessions, anything waiting in
   `requires_action`, and the mode's headline strip.

*Behind the scenes:* every subsequent call rides the cookie through the same
auth path, scopes, rate limits, and audit identity as the key itself
(spec §4.3). Sign-out (`DELETE /console/session`) or key revocation kills the
session.

*Watch out:* an `admin`-scoped key triggers a one-time nudge — browse with a
`read` key instead; issue one in Settings → API keys.

### W2 — Find and read a session

1. **Sessions** → one list, filters for status/agent/environment, cursor
   pagination. Or arrive directly via a deep link the CLI printed
   (`/console/sessions/<id>`).
2. Detail leads with the crucial facts (DP-1): status + stop reason,
   agent@version + environment, cost so far.
3. **Trace** tab: chronological events; tool calls show name/input/output,
   collapsed until expanded (DP-2); filter to tool calls or errors only.
4. **Tree** tab: the JSONL fork structure. **Usage** tab: tokens + USD.
   **Outputs** tab: list and download files.

*Behind the scenes:* `GET /v1/sessions`, `…/entries`, `…/tree`, `…/usage`,
`…/outputs` — the same reads `curl` gets.

---

## 3. Pi-coder journeys (`read`+`write`)

### W3 — Watch a delegated session live (browser side of U2)

1. Delegate from your terminal (`/remote:delegate …`); the CLI prints a
   console deep link.
2. Open it (or don't — the tab you already had flips its favicon when status
   changes, DP-11). The Trace live-tails over SSE; a dropped connection
   resumes from the last position, nothing missed.
3. It completes; pull outputs from the Outputs tab, or back in your terminal
   with `remote_read_outputs`.

### W4 — Answer, steer, interrupt (browser side of U8)

1. A session hits an `always_ask` tool → status `requires_action` → it
   surfaces on Home and the sidebar badge, not just its own page.
2. Open it: the blocking request renders with the tool name and input; approve
   or deny (`user.tool_confirmation`). The session resumes immediately.
3. Mid-run you can queue a steering note (`user.message`) or stop the turn
   (`user.interrupt`) — state is never lost, the log is durable.

*Watch out:* with a `read` key these controls render disabled with the reason,
not hidden — you can see what you *would* be able to do (spec §6.1).

### W5 — Continue from any browser (browser side of U4; phase 4)

1. On a machine with no Pi: Sessions → your idle session → **Conversation**
   tab.
2. The conversation renders from the session's messages; type in the composer
   → the session cold-wakes and the reply streams in. Follow-ups queue while a
   turn runs; interrupt is one click; `requires_action` appears in the
   composer itself.
3. The view is honest about limits (DP-6): processes from previous turns are
   gone; outputs download to your machine, there is no local cwd.
4. Back at your dev machine, the "continue in Pi instead" affordance shows
   `/remote:resume <id>` — both surfaces hand off to each other.

### W6 — Fork instead of disturb

On a running or precious session: **Fork** creates a branch sharing history to
the fork point (`POST …/fork`); the new session id links straight to its own
page, and the CLI command to attach to it is shown.

### W7 — Inspect scheduled work (browser side of U5)

**Jobs** → schedule, last-run outcome, next fire (DP-1); run history with
per-run session links; manual trigger (write); an auto-paused job shows its
pause reason (archived agent, missing vault) front and center.

---

## 4. Tenant-admin journeys (`admin`)

### W8 — Onboard and first minute (saas; browser side of T1)

1. Signup page (only if `onboardingEnabled`): tenant name + email → tenant +
   admin key **shown exactly once** with copy-and-confirm. No card required;
   a trial balance is granted.
2. First-run checklist (DP-12), one path: add a `model_provider_key` to a
   vault → create an agent → start a first session and watch it live. Under a
   minute to something real.
3. Install instructions for the Pi extension are reprinted in Settings any
   time.

### W9 — Issue keys with least privilege (browser side of T2)

Settings → API keys: issue (scopes opt-up from `["read"]`), secret shown once,
revoke with typed confirmation. The list shows scope chips so an over-broad
key is visible at a glance.

### W10 — Define agents and environments (browser side of T3)

1. **Agents**: create; edit — the UI says plainly that PATCH creates version
   n+1 and running sessions keep their version; version history browsable.
2. Archive (terminal) warns with real consequences: "auto-archives the N
   scheduled jobs referencing this agent" (DP-7).
3. **Environments**: `cloud` — image, resources, network policy with one-line
   explanations of `limited` vs `unrestricted`; `self_hosted` — see W12.

### W11 — Register credentials (browser side of T4)

Vaults: create, add credentials by category. Secret fields are write-only —
never echoed after submit, ever (DP-8). The vault page explains the
fail-closed rule: no resolvable `model_provider_key` → sessions fail before
the first model call (DP-6). **Validate** checks a credential live; rotation
propagates to running sessions within ~60 s without restarts.

### W12 — Operate self-hosted execution (browser side of T5)

Environment detail (`self_hosted`): mint worker keys (shown once; the page
repeats the rule — this is the *only* key that belongs on a worker host);
live `work-stats` (depth, oldest queued, workers polling); drain via
`work-stop`, with `{force}` as an explicit second step.

### W13 — Wire notifications (browser side of T6)

Settings → Webhooks: register with an event-type picker, `whsec_` shown once,
**send test** before trusting it, delivery state visible; an auto-disabled
endpoint says so and offers re-enable.

### W14 — Watch usage and spend (browser side of T7; all modes)

Tenant dashboard: quota-vs-limit, spend over time, breakdown by agent and by
user (`metadata.userId`), CSV export. This is cost observability — present in
solo and team too, because self-hosters pay model providers real dollars.

### W15 — Top up and auto-charge (saas; spec §11)

1. Home shows balance + burn ("lasts ~N days at current rate").
2. **Top up** → hosted checkout (the console never sees a card) → back with
   the ledger credited exactly once.
3. Optional **auto-charge** (off by default): "below $10, charge $50", with
   visible daily/monthly caps and "last auto-charge" state. Repeated payment
   failures disable it and tell you — no silent retries.
4. Balance low → banner (enable auto-charge in one click). Balance exhausted →
   `suspended`: everything still readable, nothing new starts, and the page
   says exactly which action fixes it.

### W16 — Govern tool execution (browser side of T8)

Agent detail shows per-tool permission policies (`always_allow` /
`always_ask` / `always_deny`); the session trace doubles as the audit log —
every tool call, confirmation, and result is a persisted, replayable event.

---

## 5. Journey → spec map

| Journey | Spec sections | Platform journey |
|---|---|---|
| W1 | §3, §4, §5, §6 | — |
| W2 | §7, §9.9 | U2/U4 (read side) |
| W3 | §8 | U2 |
| W4 | §7.5, §8, §9.4 | U8 |
| W5 | §10 | U4 |
| W6 | §7.3 | U4 |
| W7 | §9.4 | U5 |
| W8 | §9.6, §11 | T1 |
| W9 | §9.7 | T2 |
| W10 | §9.1, §9.2 | T3 |
| W11 | §9.3 | T4 |
| W12 | §9.2 | T5 |
| W13 | §9.8 | T6 |
| W14 | §9.9, §11.2 | T7 |
| W15 | §11 | (new) |
| W16 | §9.1, §7.4 | T8 |
