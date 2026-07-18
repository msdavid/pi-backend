# Phase-3 conformance gate

Release items for the tenant-admin surface + onboarding phase
(`docs/console-spec.md` §13, cited as C§n; journeys from
`docs/console-user-journeys.md`, cited as Wn). Runs inside the single
`conformance-gate` vitest project (`pnpm test:gate`), extended — never
trimmed — like the phase-1/2 suites beside it.

| File | Pins |
|---|---|
| `axe-routes.gate.test.ts` | C§12.2: every route the router registers (enumerated programmatically — new routes cannot dodge it) renders axe-clean with representative fake data — and did NOT settle on an error state (an `ErrorAlert`-only page is trivially axe-clean and would leave the real screen unaudited; deliberate error surfaces must be annotated in `ERROR_EXPECTED_ROUTES`); keyboard spot checks on the phase-3 admin tables/dialogs/typed confirmations. |
| `secret-scan.gate.test.ts` | C§13 item §9.3: sentinel secrets driven through the vault / API-key / webhook / signup flows never survive in the DOM; static scan proves no real-looking credential literal exists anywhere in `src/` or `test/`. |
| `scope-matrix.gate.test.ts` | C§13 item §6.1, extended to phase 3: exact Resources/Settings submenu sets per scope and mode; admin mutations on browsable sections disable WITH a reason (representative pins; per-screen coverage in the feature suites). |
| `mode-matrix.gate.test.ts` | C§5: health solo/team-only (saas states the decision, ZERO probes), signup saas+onboarding-only — including solo/team WITH `onboardingEnabled: true`, so dropping the mode half of the gate fails — sign-in "Create a tenant" gate. |
| `journey-coverage.gate.test.ts` | The table below stays honest: every cited covering test still exists verbatim. |
| `perf-budget.gate.test.ts` | C§12.1, phase-3 addendum: every phase-3 screen (agents, agent/environment/vault details, vaults, environments, api-keys, webhooks, tenant, health, files, skills, signup) is emitted as its own lazy chunk and stays OUT of the initial JS set — mirrors the phase-2 pin via the shared helpers in `test/phase1-gate/helpers.ts`. |

The §1.2 endpoint allowlist stays where it is pinned —
`test/phase1-gate/api-surface.gate.test.ts` (one gate, one authority). Its
only phase-3 change was the sanctioned WP-C3.6 edit adding the two C§5.1
health probes (`/healthz`, `/readyz`) and `src/api/health.ts` as their sole
transport, each justified in comments there.

## Journey coverage — W8–W16 achievable without curl

Acceptance for WP-C3.8 (implementation plan): every tenant-admin journey
except W15 is achievable in the console alone. Pointers below are enforced
by `journey-coverage.gate.test.ts`; **gaps are called out explicitly**.

| Journey | Covered by (file → tests) | Gaps / notes |
|---|---|---|
| **W8** onboard + first minute (saas) | `src/features/onboarding/signup.test.tsx` (form → key-once → auto sign-in → checklist; step completion); `src/api/__tests__/onboarding.contract.test.ts` (real backend signup + progress); `src/features/home/home.test.tsx` (Home card back to the incomplete checklist, DP-12); `src/features/settings/settings-index.test.tsx` (install instructions reprinted in Settings, every mode) | **RESOLVED (was the W8 step-3 gap):** the `pi install` one-liner + connect steps are now reprinted on the Settings index (`src/features/settings/settings-index.lazy.tsx`), reachable any time after the checklist completes. Trial-balance copy is deliberately absent pre-phase-5 (C§9.6). |
| **W9** issue keys with least privilege | `src/features/settings/api-keys.test.tsx` (opt-up scopes, show-once + DOM-absence, revoke consequences, scope chips); `src/api/__tests__/settings-mutations.contract.test.ts` (issue → authenticate → revoke → 401 against the real backend) | — |
| **W10** define agents + environments | `src/features/agents/agents.test.tsx` + `agent-detail.test.tsx` (create; PATCH-creates-version-n+1 copy; version history; archive naming the real referencing-jobs count); `src/features/resources/environments.test.tsx` + `environment-detail.test.tsx` (cloud create, `limited`/`unrestricted` one-liners); `src/api/__tests__/agents-lifecycle.contract.test.ts` (real version bump) | — |
| **W11** register credentials | `src/features/resources/vaults.test.tsx` (create, write-only secrets incl. C§13 DOM-absence, fail-closed + ~60 s rotation copy, live validate taxonomy); `src/api/__tests__/vaults.contract.test.ts` (secretless records, deterministic validate against the real backend) | — |
| **W12** operate self-hosted execution | `src/features/resources/environment-self-hosted.test.tsx` (mint shown-once, live work-stats, drain with `{force}` as an explicit second step); `src/api/__tests__/environments.contract.test.ts` (real mint / work-stats / work-stop) | — |
| **W13** wire notifications | `src/features/settings/webhooks.test.tsx` (event-type picker from contracts, `whsec_` once, send-test with honest delivery state, auto-disabled banner + delete-and-re-register path); `src/api/__tests__/settings-mutations.contract.test.ts` (real register/test/delete) | Re-enable is delete + re-register (mints a NEW secret) — the only path the API offers; the UI says so. |
| **W14** watch usage and spend | `src/features/settings/tenant.test.tsx` (quota-vs-limit, spend over time, by-agent and by-`metadata.userId` breakdowns, verbatim CSV export); `src/api/__tests__/tenant-files-skills.contract.test.ts` (real `GET /v1/tenant/usage` grouping) | All modes (C§11.2 cost observability). |
| **W15** top up + auto-charge | **Out of scope until phase 5** (C§11, WP-C5.4). Deliberately absent from the coverage manifest. | — |
| **W16** govern tool execution | `src/features/agents/agent-detail.test.tsx` (per-tool permission-policy table with DP-6 microcopy); `src/features/sessions/trace-tab.test.tsx` (the trace as the persisted, replayable audit log — phase-2 surface) | Trace-as-audit-log is phase-2 machinery; W16 adds the governance VIEW, which is the agent-detail policy table. |

### Manual-verification notes

Automated coverage above drives the real app tree against the collaborator
fake, and the api-modules against the real backend (containers). Two spots
rest on contract tests + feature tests composed, without one single
end-to-end browser pass: (a) W8's full signup→checklist→first-session arc
against a REAL backend is split between `onboarding.contract.test.ts`
(wire) and `signup.test.tsx` (UI); (b) W12's work-stats polling cadence
(10 s refetch) is asserted as configuration, not observed over wall-clock
time. Both are acceptable per the seam rules (CONVENTIONS.md); noted here
so a future E2E harness knows where to start.
