# `@pi-managed/web-console` — read-only console (v1)

A dependency-free static SPA for browsing Pi Managed Backend sessions, tracing
chronological events, and inspecting token usage. **Read-only v1** (spec §26.6):
no create/delete/start actions — only `GET` requests.

## Pages

- **Session list** — table of sessions (id, title, status, agent, environment,
  created, token usage). Filter by status; cursor-paginated (`Next page`).
  Calls `GET /v1/sessions`.
- **Session detail / tracing** — header (status, stop reason, timestamps) and a
  chronological event list from `GET /v1/sessions/:id/entries`. Tool-execution
  events (`agent.tool_use`, `agent.tool_result`, …) render the tool name, input
  (as JSON), output, and a truncated flag. Duration is not exposed by the API
  (shown as `—` when absent).
- **Usage panel** — `GET /v1/sessions/:id/usage` (input/output/cache tokens +
  USD cost).

## Auth

Every request carries `Authorization: Bearer <apiKey>`. The key is supplied at
runtime via the UI and stored in **browser localStorage** (`pi-managed-console.*`
keys). The UI warns that the key lives client-side; use a dedicated key and
clear it when done. **No credentials are ever baked into the build.**

## Serving

The console is **mounted on the backend at `/console`** (same origin as `/v1`,
so the SPA's same-origin `fetch` calls need no CORS). The backend serves the
built assets via a root-level `onRequest` hook registered *before* bearer auth
(see `packages/backend/src/api/console.ts`); the hook short-circuits `/console`
and `/console/*` so the SPA loads without a key, while every `/v1/*` call still
requires one.

For local SPA development there is also a standalone static server:

```sh
pnpm --filter @pi-managed/web-console build
PORT=4173 pnpm --filter @pi-managed/web-console serve
# then open http://localhost:4173 and set "API base URL" to the backend origin
```

## Build

`pnpm build` runs `scripts/build.mjs`, which copies `src/` → `dist/` (no bundler,
no framework, no runtime deps). `dist/` is what the backend serves.

## Tests

`pnpm test` (vitest):

- `apiClient` issues the right `GET` requests with a Bearer header, correct
  paths (`/v1/sessions`, `…/:id`, `…/entries`, `…/usage`), and query params; it
  throws on non-2xx carrying the status.
- A build smoke test runs the build and asserts `dist/index.html` loads
  `app.js` + `styles.css`, and `app.js` references the read-only endpoints and
  issues **no** mutating verbs.

## Notes / limitations (v1)

- The session resource does not expose a `model` field; the list shows the
  agent id + version instead.
- `agent.tool_result` duration is not surfaced by the current API; shown as `—`.
- The console is intentionally dependency-free and framework-less.
