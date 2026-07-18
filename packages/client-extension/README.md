# `@pi-managed/client` — Pi client extension

Bridges a local Pi to the Pi Managed Backend (spec:
[`docs/spec/spec.md`](../../docs/spec/spec.md) §24; journeys:
[`docs/user-journeys.md`](../../docs/user-journeys.md) U1–U6). Loaded
in-process by local Pi; talks to the backend over the public `/v1` REST + SSE
API using `@pi-managed/contracts` types. The API key lives in Pi's
AuthStorage; `settings.json` stores only a reference to it.

## Surface

- **Commands** — `/remote:config`, `/remote:login`, `/remote:start`,
  `/remote:resume`, `/remote:sessions`, `/remote:delegate`, `/remote:attach`,
  `/remote:detach`, `/remote:fork` (`src/commands/remote.ts`);
  `/remote:cron` + `/remote:jobs` (`src/commands/cron.ts`); memory and vault
  commands (`src/commands/memory.ts`, `src/commands/vault.ts`).
- **Agent tools** — the seven `remote_*` tools plus the `tool_call`
  delegation-gating hook and `--remote*` flags (`src/tools/remote-tools.ts`);
  memory and vault tools.
- **Live-view panel** — SSE-backed session rendering and the two durable
  delegation entries (`src/panel/`).
- **API client** — typed REST + SSE client over
  [`docs/api-reference.md`](../../docs/api-reference.md)
  (`src/api-client.ts`); reconnects with `Last-Event-ID`, falls back to
  polling.

## Console deep links (console-spec §1.4)

Wherever the extension prints a session id — start/resume/delegate/attach/fork
output, `/remote:sessions` rows, `/remote:cron run` triggers, and the
`remote_delegate` / `remote_start_session` tool results — it also prints the
session's console URL, `<backendUrl>/console/sessions/<id>`, derived from the
configured backend URL via `ManagedApiClient.consoleSessionUrl()`. No extra
configuration.

## Verify

```
pnpm --filter @pi-managed/client typecheck
pnpm --filter @pi-managed/client test
```
