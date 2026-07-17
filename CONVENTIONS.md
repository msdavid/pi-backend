# Pi Managed Backend — Binding Conventions

> This document is the **binding conventions** reference for anyone working on this
> codebase. When this file and `docs/spec/spec.md` disagree, `spec.md` is authoritative.

## Technology decisions (locked; changing one = a deliberate, discussed decision)

- Node 20+, TypeScript strict, ESM. pnpm workspaces.
- HTTP: **Fastify** (SSE via reply hijack; JSON schema validation from `contracts` zod
  schemas). DB: **Postgres via `pg`** + a thin query layer; migrations with
  **node-pg-migrate** (SQL files, forward-only). No heavyweight ORM — row-level tenant
  filtering must be auditable (§27.1), so queries stay explicit; a `tenantScoped(query)`
  helper makes the filter mandatory by construction.
- Validation: **zod** (single source in `contracts`, reused server + client extension).
- Tests: **vitest**; integration tests use testcontainers-Postgres; sandbox/KVM tests are
  tagged `@kvm` and run only on a KVM-capable machine.
- IDs: prefixed (`agent_`, `env_`, `sess_`, `vault_`, `mem_`, `memver_`, `skill_`,
  `file_`, `job_`, `wh_` — §6.6), ULID payload, generated server-side.
- Password/API-key hashing: **argon2id** (§8). Secrets encryption at rest: AES-256-GCM
  with a KMS-or-keyfile-provided key (§28).
- Errors: single wire error shape defined in api-reference.md conventions; internal errors
  extend one error class with a machine-readable `code` — see "Errors: one base, one edge"
  below for the binding form of this rule.
- Lint/format: eslint + prettier, configured once at the repo root; never restyle
  neighboring code.

## Repository layout (pnpm workspace monorepo)

```
/packages
  /contracts          # wire types + zod schemas, kept in sync with api-reference.md.
                      # THE synchronization artifact between server and clients.
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
  /worker             # default self-hosted worker (§10.4)
  /web-console        # @pi-managed/web-console — read-only web console (§26.6)
  /testkit            # shared test fixtures: pg testcontainer, fake sandbox provider,
                      #   SSE test client, tenant/api-key factories
/docs
  api-reference.md    # wire contract
  db-schema.md        # schema doc (generated — see `pnpm db:schema:gen`)
  internal-contracts.md # internal seam interfaces
  /spec
    spec.md             # feature spec
    multi-host-design.md # multi-host sandbox scheduling design note
```

## General rules

1. The spec (`docs/spec/spec.md`, cited as `§x.y` throughout the codebase) is
   authoritative for feature behavior.
2. Never place provider credentials in `process.env`, code, or fixtures (§4.2, §25).
3. Match existing conventions exactly; no drive-by refactors.

## Errors: one base, one edge (binding)

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

## Fakes at the seam under test (binding, lint-enforced)

> **A fake is legitimate for a COLLABORATOR. It is never legitimate for the SUBJECT.
> Where a boundary is the subject, both sides must be real.**

This rule exists because of a specific, already-shipped bug: the client streamed
`…/events/stream`, the backend served `…/stream`, so **every** client SSE connection 404'd —
and the client test was *green*, because it stubbed `fetch` and asserted the URL its own client
had produced. A stub can only confirm what the subject already believes. Such a test does not
merely fail to catch the bug; it **enshrines** it, and makes the next "the tests pass" report
true and worthless.

**The rule.**

- Identify the **subject** of a test: the thing it is named after and the thing whose behavior
  the assertions describe.
- Everything the subject *talks to* is a **collaborator**. Fake collaborators freely — that is
  what fakes are for (the sandbox provider, the object store, the clock, a scripted upstream).
- If the subject **is a boundary** — an HTTP client, a wire contract, a provider adapter, the
  Pi-SDK seam — then that boundary may not be faked in its own test. Drive the real other side:
  the real in-process Fastify app (client↔server), the real provider under `@kvm`, a real local
  server (pinned-socket/SSRF transport), the real DB via testcontainers.
- Corollary: a test must exercise the code production actually runs. A green test over a
  component with no production call site is not coverage.

**Enforcement.** The local ESLint rule `seam/no-fake-at-seam` (defined in `eslint.config.mjs`,
applied to every `*.test.ts`) is an error on:

1. replacing the global transport — `globalThis.fetch = …`, `vi.stubGlobal("fetch", …)`,
   `vi.spyOn(globalThis, "fetch")`;
2. `vi.mock()` of the *module under test* (subject inferred from the filename: `foo.test.ts`
   mocking any `…/foo.js`);
3. injecting a fake transport (`fetchImpl`) into a **seam/contract test** — currently
   `client-extension/src/api-client.test.ts` and any `*contract*.test.ts` /
   `*conformance*.test.ts` under `client-extension/src/**`, whose entire purpose is that both
   sides of the seam are real.

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
