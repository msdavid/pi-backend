# Audit remediation ledger

End-to-end security / robustness / performance audit remediation. Every fix is tagged in code
with its finding id (`SEC-*`, `ROB-*`, `PERF-*`); this is the index + the operator/client-visible
behavior changes. Delivered on branch `fix/audit-remediation`; full suite green (913 backend tests,
all packages typecheck + lint clean).

## Security

| ID | Fix | Files |
|----|-----|-------|
| SEC-1 | Verified-key cache + per-IP failed-auth throttle ahead of argon2 (DoS + throughput ceiling) | `domain/tenant/api-key.ts`, `api-key-cache.ts`, `api/middleware/auth.ts` |
| SEC-2 | MCP egress routed through `safeFetchPinned` (`preserveRequestAuth`); `mcpServers[].url` validated http/https | `domain/mcp/client.ts`, `pi-extensions/mcp-bridge/`, `contracts/agent.ts` |
| SEC-3 | OAuth `tokenUrl` pinned + https-validated (kills refresh-loop SSRF) | `domain/vault/refresh.ts`, `contracts/vault.ts` |
| SEC-4 | Multi-host host-agent channel fails closed without https + mTLS | `app.ts`, `infra/config`, `infra/sandbox/multi-host-provider.ts` |
| SEC-5 | `always_deny` permission policy hard-blocks + excluded from materialization | `pi-extensions/permission-gate/`, `domain/toolset/materialize.ts` |
| SEC-6 | Versioned-store redaction purges all S3 versions (`hardDelete`) | `domain/memory/version.ts`, `infra/objectstore/s3.ts`, `domain/ports.ts` |
| SEC-7 | MCP/OAuth credential resolver fails closed on unresolvable binding | `domain/mcp/proxy.ts`, `credential-resolver.ts` |
| SEC-8 | SSRF classifier blocks NAT64 `64:ff9b::/96` + 6to4 `2002::/16` | `domain/net/ssrf-pin.ts` |
| SEC-9 | Log redaction aligned to camelCase credential fields + `apiKey` | `infra/telemetry/logger.ts` |
| SEC-10 | Postgres RLS backstop (migration 040) + `SET LOCAL` in `tenantScoped*`; guard now verifies the tenant id is bound to the `tenant_id` predicate | `migrations/040`, `infra/db/tenant-scoped.ts` |
| SEC-11 | Console static-serve path-traversal prefix check uses a separator | `api/console.ts` |
| SEC-12 | Security headers (CSP/X-Content-Type-Options/X-Frame-Options/Referrer-Policy) | `server.ts` |
| SEC-13 | Onboarding disabled by default (secure self-hosted default) | `infra/config` |
| SEC-14 | `tenantScopedAll` rejects non-identifier table names; verify-timing decoy on the auth miss path | `infra/db/tenant-scoped.ts`, `domain/tenant/api-key.ts` |

## Robustness

| ID | Fix |
|----|-----|
| ROB-1 | Webhook fetch timeout + abort; dispatcher in-flight guard + bounded per-tick parallelism |
| ROB-2 | Secret bindings baked into `provisionSpec` so crash recovery keeps `$MSB_*` |
| ROB-3 | Sandbox reaper destroys VMs orphaned by archived/terminated sessions |
| ROB-4 | Eviction checkpoints a still-running VM instead of cancelling the stop |
| ROB-5 | Concurrent `user.message` rejected with `409 session_not_idle` |
| ROB-6 | Unhandled-rejection kill vectors caught (budget read fails safe; idle checkpoint self-contained) |
| ROB-7 | Usage recorded once (turn_end only) — fixes the systematic 2× token/cost double-count |
| ROB-8 | Postgres rate-limit store actually wired (cross-replica ceiling) |
| ROB-9 | Scheduler lease moved into SQL + claim heartbeat (no cross-node double-fire) |
| ROB-10 | Work-results drained on runtime wake (multi-instance delivery) |
| ROB-11 | Work-queue visibility timeout reaps stale claims |
| ROB-12 | Idempotency claim lease — a crash no longer 409s a key for 24h |
| ROB-13 | Boot `running→idle` reset scoped by instance ownership + lease |
| ROB-14 | Durable usage recording (idempotency-keyed retry, awaited at settlement) |
| ROB-15 | File-storage reserved atomically in `uploadFile`; monthly token-spend admission gate at session-create |
| ROB-16 | Skill-upload zip-bomb caps + bounded inflation |
| ROB-17 | Disk limit applied; per-VM maxima; placement subtracts live usage (admission control) |
| ROB-18 | Idle-checkpoint vs resume race settled (await in-flight stop on resume) |
| ROB-19 | Dispatcher retries transient errors instead of terminal-failing |
| ROB-20 | Quota delta off-by-one fixed; `reconcileQuotaCounter` for drift |
| ROB-21 | Event-projection append serialized via per-session advisory lock (no livelock/drop) |
| ROB-22 | Scheduler catch-up storm batch-inserted; `postResult` guards against a stopped item |

## Performance

| ID | Fix |
|----|-----|
| PERF-1 | Configurable pool size + connection/statement timeouts (`DB_POOL_MAX`, …) |
| PERF-3 | SSE first-connect replay paged instead of loading whole history |
| PERF-4 | JSONL endpoints stream line-by-line with early termination |
| PERF-5 | File upload no longer triple-buffers (streamed, byte-counted) |
| PERF-6 | Scheduler tick cursor is one batched query, not N+1 |
| PERF-7 | Quota check computes only the requested dimension |
| PERF-8 | Sessions-list sort index (migration 036) |
| PERF-9 | `session_events` retention loop (migration 037) bounds projection growth |
| PERF-10 | Filesystem `list()` scoped to prefix dir + `head()`; JSONL sync skips unchanged files |
| PERF-11 | `last_used_at` write throttled; memory staging parallelized |

## Migrations added

`036` sessions owner-instance + list index + placement footprint · `037` session_events retention
indexes · `038` file-storage quota counter backfill · `039` idempotency claim lease · `040`
row-level-security policies + `app_tenant_visible()`.

## Client / operator behavior changes

- **MCP server URL validation (SEC-2):** an agent config whose `mcpServers[].url` is not a valid
  `http(s)` URL is now rejected on create/update.
- **`409 session_not_idle` (ROB-5):** posting a `user.message` while a session is running/rescheduling
  is rejected; retry once idle.
- **`409 conflict` on work-result (ROB-22):** posting a result for a stopped work item now 409s (was 404).
- **`429 rate_limited` on session-create (ROB-15):** a tenant already over `monthlyTokenSpendUsd`
  cannot start new sessions.
- **Onboarding off by default (SEC-13):** set `ONBOARDING_ENABLED=true` to keep public sign-up.
- **DB role (SEC-10):** the app's `DB_URL` role must be non-superuser for the RLS backstop to apply
  (see `docs/deploy.md`).
- **Multi-host fail-closed (SEC-4):** `SANDBOX_MODE=multi` requires https + mTLS (or the dev-only
  `SANDBOX_ALLOW_INSECURE_HOST_AGENT`).

## Known follow-ups (non-blocking)

- `domain/quota/enforce.ts` is 627 lines (over the 600 soft limit) after the ROB-15/ROB-20/PERF-7
  additions; extracting the usage-query helpers into `quota/usage.ts` is a clean but purely cosmetic
  refactor, left out to avoid churn on green code.
- Cross-process exactly-once usage durability (ROB-14) would need a `usage_records` idempotency key +
  a port change; the in-memory keyed retry covers transient failures.
