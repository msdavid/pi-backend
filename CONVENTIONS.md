# Pi Managed Backend — Binding Conventions

> This document is the **binding conventions** reference for every coding agent and the
> orchestrator. It reproduces, verbatim, the technology decisions (plan §3.2) and the
> rules every coding agent must follow (plan §3.4). When this file and the implementation
> plan disagree, the implementation plan is authoritative; when the plan and `spec.md`
> disagree, `spec.md` is authoritative (plan §1 "Source of truth").

## Technology decisions (locked; changing one = human escalation)

Reproduced from `implementation-plan.md` §3.2:

- Node 20+, TypeScript strict, ESM. pnpm workspaces.
- HTTP: **Fastify** (SSE via reply hijack; JSON schema validation from `contracts` zod
  schemas). DB: **Postgres via `pg`** + a thin query layer; migrations with
  **node-pg-migrate** (SQL files, forward-only). No heavyweight ORM — row-level tenant
  filtering must be auditable (§27.1), so queries stay explicit; a `tenantScoped(query)`
  helper makes the filter mandatory by construction.
- Validation: **zod** (single source in `contracts`, reused server + client extension).
- Tests: **vitest**; integration tests use testcontainers-Postgres; sandbox/KVM tests are
  tagged `@kvm` and run only on the KVM-capable runner.
- IDs: prefixed (`agent_`, `env_`, `sess_`, `vault_`, `mem_`, `memver_`, `skill_`,
  `file_`, `job_`, `wh_` — §6.6), ULID payload, generated server-side.
- Password/API-key hashing: **argon2id** (§8). Secrets encryption at rest: AES-256-GCM
  with a KMS-or-keyfile-provided key (§28).
- Errors: single wire error shape defined in api-reference.md conventions; internal errors
  extend one error class with a machine-readable `code` — see "Errors: one base, one edge"
  below for the binding form of this rule.
- Lint/format: eslint + prettier, configured once in WP-0.1; agents never restyle
  neighboring code.

## Repository layout (pnpm workspace monorepo)

Reproduced from `implementation-plan.md` §3.1:

```
/packages
  /contracts          # wire types + zod schemas, generated-adjacent to api-reference.md.
                      # THE synchronization artifact. Changes = dedicated WP.
  /backend            # the service
    /src
      /api            # HTTP routes, one dir per resource family (agents/, sessions/, ...)
      /domain         # business logic, one dir per subsystem (session-manager/, scheduler/,
                      #   vault/, webhook/, memory/, outcome/, multiagent/, ...)
      /infra          # db/ (pg + migrations), objectstore/, sandbox/ (msb provider),
                      #   telemetry/, config/
      /pi-extensions  # managed-feature Pi extensions loaded into AgentSessions
                      #   (tasks/, goals/, permission-gate/, mcp-bridge/, subagent/,
                      #   custom-tools/)
  /client-extension   # @pi-managed/client (§24)
  /worker             # default self-hosted worker (§10.4, Phase 4)
  /web-console        # @pi-managed/web-console — read-only web console (§26.6)
  /testkit            # shared test fixtures: pg testcontainer, fake sandbox provider,
                      #   SSE test client, tenant/api-key factories
/docs
  api-reference.md    # wire contract (Wave 0)
  db-schema.md        # schema doc (Wave 0)
  internal-contracts.md # internal seam interfaces (Wave 0/Phase 1)
  /spec
    spec.md
    implementation-plan.md
    progress.md       # orchestrator ledger
```

## Rules every coding agent must follow

Reproduced verbatim from `implementation-plan.md` §3.4:

1. Work only inside your assigned paths. If you believe you must touch a shared file not
   listed in your brief, **stop and report** — do not edit it.
2. The spec (§ refs in your brief) is authoritative. If the brief contradicts the spec,
   report the contradiction; don't pick silently.
3. Verify before reporting: run the listed commands; report actual output honestly.
4. No new dependencies without listing them in your report (orchestrator approves).
5. Never place provider credentials in `process.env`, code, or fixtures (§4.2, §25).
6. Match existing conventions exactly; no drive-by refactors.
7. Do not commit — leave the worktree dirty-or-committed per orchestrator instruction
   (default: commit to your branch, never push, never merge).

## Errors: one base, one edge (R7.2 — binding)

> **`ApiError` is declared in `packages/backend/src/domain/errors.ts`. Domain code throws it;
> `server.ts` renders it. Nothing imports errors from `server.js`, ever.**

This is the single error convention for the backend. It exists because the old one inverted the
layering: `ApiError` was declared in `server.ts` (the Fastify composition root), so ~30 domain
modules imported the HTTP layer while the HTTP layer imported them back — a genuine import
cycle, visible in `domain/vault/validate.ts`, which used a dynamic
`await import("../../server.js")` purely to dodge it.

**The rule.**

- **One base class.** Anything that must reach the client as a well-formed error is an
  `ApiError` from `domain/errors.ts` — thrown from domain services, route handlers and
  middleware alike. Do not declare a second HTTP-facing error type, do not re-export `ApiError`
  from another module, and do not import it from `server.js` (it is not exported there).
  The package's public surface re-exports it from `src/index.ts`.
- **It carries the taxonomy, not the transport.** `new ApiError(statusCode, code, message,
  details?)`. `code` is the machine-stable `ErrorCode` from `@pi-managed/contracts`; `details`
  is optional structured context. The status is *data on the error*, not something inferred at
  the edge, because the published taxonomy (`docs/api-reference.md`) is not a function of `code`
  alone — `invalid_request` is 400 for a malformed request and 422 for a well-formed but
  unprocessable one; `resource_archived` is 409 or 422 depending on the operation. Both halves
  of the pair are the contract: **changing a status or a code is a wire-contract change**, not a
  refactor.
- **`domain/errors.ts` has no HTTP dependency.** Its only import is the `ErrorCode` type from
  `contracts` (the wire *contract*, not the wire *layer*). Nothing in `domain/` may import
  Fastify, a reply, or `server.js`.
- **Rendering happens exactly once.** The global Fastify error handler in `server.ts` is the
  only code that maps an error to a status + `ErrorEnvelope` JSON body. Domain code never builds
  an envelope and never touches a reply. An error that reaches the handler and is not an
  `ApiError` is by definition a bug, and is rendered as `500 internal_error` with the message
  withheld.
- **Infrastructure errors stay their own types.** `SsrfBlockedError`, `TenantScopeError`,
  `HostUnavailableError`, `NoHostAvailableError`, … are internal signals, not wire errors.
  Whoever catches one at a request boundary converts it to an `ApiError` with the right
  status/code; anything left unconverted surfaces as `500 internal_error`. Adding a new one is
  fine; giving it an `httpStatus` field and teaching the error handler about it is not.

## Fakes at the seam under test (R1.3 — binding, lint-enforced)

> **A fake is legitimate for a COLLABORATOR. It is never legitimate for the SUBJECT.
> Where a boundary is the subject, both sides must be real.**

This is remediation-plan rule §0.2, made enforceable. It exists because of a specific,
already-shipped bug: the client streamed `…/events/stream`, the backend served `…/stream`,
so **every** client SSE connection 404'd — and the client test was *green*, because it stubbed
`fetch` and asserted the URL its own client had produced. A stub can only confirm what the
subject already believes. Such a test does not merely fail to catch the bug; it **enshrines**
it, and makes the next agent's "the tests pass" report true and worthless.

**The rule.**

- Identify the **subject** of a test: the thing it is named after and the thing whose behavior
  the assertions describe.
- Everything the subject *talks to* is a **collaborator**. Fake collaborators freely — that is
  what fakes are for (the sandbox provider, the object store, the clock, a scripted upstream).
- If the subject **is a boundary** — an HTTP client, a wire contract, a provider adapter, the
  Pi-SDK seam — then that boundary may not be faked in its own test. Drive the real other side:
  the real in-process Fastify app (client↔server), the real provider under `@kvm`, a real local
  server (pinned-socket/SSRF transport), the real DB via testcontainers.
- Corollary (plan §0.3): a test must exercise the code production actually runs. A green test
  over a component with no production call site is not coverage.

**Enforcement.** The local ESLint rule `seam/no-fake-at-seam` (defined in `eslint.config.mjs`,
applied to every `*.test.ts`) is an error on:

1. replacing the global transport — `globalThis.fetch = …`, `vi.stubGlobal("fetch", …)`,
   `vi.spyOn(globalThis, "fetch")`;
2. `vi.mock()` of the *module under test* (subject inferred from the filename: `foo.test.ts`
   mocking any `…/foo.js`);
3. injecting a fake transport (`fetchImpl`) into a **seam/contract test** — currently
   `client-extension/src/api-client.test.ts` and any `*contract*.test.ts` /
   `*conformance*.test.ts` under `client-extension/src/**`, whose entire purpose is that both
   sides of the seam are real (R3.2).

The rule is deliberately narrow: it targets the class of bug above, not mocking in general.
Mocking a *collaborator* module, injecting a scripted collaborator, and stubbing a clock are
all untouched.

**Opting out.** Annotate with a reason:

```ts
// seam-ok: <why this fake stands in for a collaborator, not for the subject>
globalThis.fetch = tripwire;
```

The comment is honored on the offending line, the line directly above it, or in the file's
top-of-file comment block (file-scoped). **The reason is mandatory and is the point** — it is
what a reviewer reads to decide whether the fake is legitimate. `// seam-ok:` with a hand-wave
is a review failure, not a passing lint. Grep `seam-ok:` to audit every exemption in the repo;
each one is a debt with an owner, and an exemption that says "pending suite X" must be deleted
when X lands.
