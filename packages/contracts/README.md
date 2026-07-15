# @pi-managed/contracts

Wire types + zod schemas. **THE synchronization artifact** — this package mechanically
mirrors [`docs/api-reference.md`](../../docs/api-reference.md). Change the doc first,
then this package, in the same work package (plan §3.2, WP-0.9).

## Rules

- Every schema here has a 1:1 correspondence with a section of `docs/api-reference.md`.
  Do not diverge. When the doc and this package disagree, the doc is authoritative;
  report the contradiction, do not pick silently.
- New resource families / event types are appended to the doc first, then here, in the
  same work package.
- No new dependencies beyond `zod`.

## Layout

| File | api-reference.md section |
| --- | --- |
| `ids.ts` | §"ID format" — prefixed resource IDs |
| `common.ts` | Conventions § — errors, pagination, name, timestamps, metadata, budget/usage |
| `agent.ts` | §"Agents" |
| `environment.ts` | §"Environments" |
| `session.ts` | §"Sessions" |
| `events.ts` | §"Events & SSE" + §"Event-type naming scheme" (FINAL catalog) |
| `vault.ts` | §"Vaults" |
| `memory.ts` | §"Memory stores" |
| `file.ts` | §"Files" |
| `skill.ts` | §"Skills" |
| `outcome.ts` | §"Outcomes" |
| `job.ts` | §"Scheduled Jobs (Crons)" |
| `webhook.ts` | §"Webhooks" |
| `tenant.ts` | §"Tenant / admin" |

## Security invariants (enforced by test)

- Vault credential sensitive fields (`token`, `accessToken`, `clientSecret`,
  `secretValue`) are **write-only**: present in `CredentialCreate`, absent from
  `Credential`.
- Webhook `signingSecret` is present only on `WebhookCreateResponse`, never on `Webhook`.
- API key raw `key` is present only on `ApiKeyCreateResponse`, never on `ApiKey`.
- `tenantId` is never client-supplied (absent from every create schema).

## Verify

```
pnpm --filter contracts typecheck
pnpm --filter contracts build
pnpm --filter contracts test
```
