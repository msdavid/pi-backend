# Phase-4 conformance gate

Release items for the continue-from-any-browser phase (`docs/console-spec.md`
§10, cited as C§n; journey W5 from `docs/console-user-journeys.md`). Runs
inside the single `conformance-gate` vitest project (`pnpm test:gate`),
extended — never trimmed — like the phase-1/2/3 suites beside it.

| File | Pins |
|---|---|
| `phone-viewport.gate.test.ts` | C§10.5, the DOM + JS half — deliberately width-independent: jsdom applies no stylesheet cascade, so a faked 375-px window would be read by nothing (an earlier revision proved exactly that) and this file claims no viewport. It pins the drawer disclosure JS (`aria-expanded` + the `drawerOpen` module class the shipped phone rules target, closing on navigation), the W5 wiring (session → Conversation tab → composer send → `user.message` on the wire, axe-clean), and the DOM-structural overflow smoke — no inline fixed width past 375 px, every data table inside its focusable scroll container (`src/ui/table.tsx`). |
| `responsive-css.gate.test.ts` | C§10.5, the CSS half, statically: 720 px is THE one phone breakpoint (`src/styles/tokens.css`) — any other max-width media query in source or built CSS fails; and the key phone-width modules (shell drawer, conversation composer, interact panel, dialog) each keep their 720-px block in source AND in the built CSS the backend serves, identified by their scoped class names (accepts the minifier's `(width<=720px)` rewrite). |
| `no-pwa.gate.test.ts` | C§10.5 responsive-only decision (`console.md` §10.5): no web-app manifest and no service-worker file/registration anywhere in `dist/` or production `src/`; the served `index.html` links no manifest and keeps the viewport meta. Plus the static overflow half: no stylesheet the build ships declares an absolute `width`/`min-width` beyond 375 px. |
| `perf-budget.gate.test.ts` | C§12.1 phase-4 addendum: phase 4 added no routes, so the pin is placement — `session-detail.lazy` stays a lazy chunk out of the initial JS set, and the conversation surface itself (pinned by its C§10.4 hand-back copy) ships in that lazy chunk graph, never in an initial chunk. |
| `continue-anywhere.gate.test.ts` | The plan's phase-4 gate flow, scripted (`@kvm`): REAL `createManagedApp` composition (real Postgres testcontainer, real object store, real `SessionManager`/`ManagedSessionRuntime`, the REAL `MicrosandboxProvider`) driven through the console's own client (cookie session + CSRF + idempotency). Wake: the first `user.message` to the idle session cold-provisions an actual microVM and turn 1 settles `completed` with the transcript durable in `/messages`. requires_action: an `always_ask` tool blocks turn 2 through the real permission-gate extension wiring; the console's `user.tool_confirmation(allow)` resumes it. Interrupt: `user.interrupt` settles turn 3 as `user_interrupt`. Hand back: the synced JSONL holds all three turns' user messages in order — the state `/remote:resume <id>` picks up. |

The one collaborator in the `@kvm` flow is the model brain
(`AgentSessionFactory`) — a real turn would spend a live model-provider key,
which the repo's fixtures may not hold (CONVENTIONS.md §4.2). It stands
behind the same documented factory seam as the production
`PiAgentSessionFactory` and drives the runtime the way Pi does (registers
the material's extension factories, invokes the `tool_call` hook, appends to
the real local JSONL, resolves its prompt on `abort()`).

Gating: the `@kvm` file needs `/dev/kvm` + the microsandbox runtime AND a
container runtime; missing either prints a loud skip banner
(`./helpers.ts`, `src/api/__tests__/harness.ts`) and is a hard failure under
`PI_REQUIRE_INTEGRATION=kvm` / `=containers` respectively. The kvm probe
runs microsandbox's own `isInstalled()` as a child process from
`packages/backend` (where the dependency resolves) — same probe as the
backend's `kvm-gate.ts`, no new dependency here.

## Manual residue (what the scripted gate cannot prove)

jsdom computes no layout and applies no stylesheet cascade, and no test can
assert "this machine has no Pi installed". Before calling C§10.5 done for a
release, walk this once in a real browser (device emulation at 375×667 or an
actual phone), on a machine/browser profile with no Pi extension:

1. Sign in → the sidebar is a top bar; **Menu** opens/closes the drawer;
   nothing scrolls horizontally on Home, Sessions, or a session page.
2. Session → Conversation: the transcript is readable, the message field is
   full-width, the on-screen keyboard does not hide the composer (dvh), and
   Send → waking note → reply lands at turn end.
3. One `requires_action` approve and one Interrupt from the composer area,
   by touch.
4. Dialogs (e.g. New session / Issue key) fit the viewport and scroll
   internally; toasts stay inside the screen edge.
5. Back on a dev machine, `/remote:resume <id>` picks the session up with
   the browser-driven turns in its history. The scripted gate proves only
   the durable JSONL that resume reads; on the CLI side the sole automation
   is a fully-mocked unit test of `runResume`
   (`packages/client-extension/src/commands/remote.test.ts` — stubbed API
   client, no HTTP, no real CLI process). There is NO automated end-to-end
   CLI resume, so this step is genuinely manual.

Everything else in the phase-4 acceptance runs scripted in the five files
above.
