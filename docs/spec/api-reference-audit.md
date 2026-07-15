# API Reference Consistency Audit (WP-0.7)

> **RETRACTED IN PART (2026-07-14, R8).** The original pass below (2026-07-13) checked
> `docs/api-reference.md` for internal consistency against `spec.md` — **before any backend
> code existed**. It could not have caught, and did not catch, defects in how the wire
> contract was actually implemented, because there was no implementation yet. Its
> "Defects: None found" / "approved as the wire contract" verdict is retracted as
> **unearned**: a docs-against-docs review proves internal consistency, not correctness of
> an implementation that postdates it by weeks.
>
> **Concretely, one of the exact defects this audit's method could not see actually
> shipped**: `api-reference.md` contradicted itself on the SSE path (`…/events/stream` at
> one line vs `…/stream` at another); the backend that was later built served `…/stream`
> while the client extension that was later built called `…/events/stream` — every SSE
> connection 404'd and silently degraded to polling with no message content. This was
> found by `remediation-plan.md` R3.1 (a *code* audit, months after this doc), fixed, and
> is now proven consistent by `test/contract/api-client-conformance.test.ts`, which drives
> the real extension API client against a real in-process backend (not a stub) — this test
> ran and passed in the 2026-07-14 verification pass (`docs/spec/progress.md`).
>
> **What was re-checked for real, in this pass, and found consistent:**
> - The SSE route is `GET /v1/sessions/:id/stream` in all three places that must agree:
>   `packages/backend/src/api/events.ts:248` (server), `packages/client-extension/src/api-client.ts:380`
>   (client), and `docs/api-reference.md:905` (doc). Confirmed by direct `grep`, not by reading
>   the docs.
> - Route count: a `grep -c` of `app.(get|post|patch|delete|put)(` across
>   `packages/backend/src/api/*.ts` (excluding `self-hosted/routes.ts`, which registers
>   separately) finds 86 registered handlers — in the right order of magnitude for the ~37
>   §8-documented endpoints once admin/console/health/self-hosted routes (not part of §8) are
>   subtracted, but this pass did **not** re-derive a route-by-route match.
> - The 13-code error taxonomy is still referenced consistently in `domain/errors.ts` doc
>   comments.
>
> **What this pass explicitly did NOT do — a full re-audit was out of scope for R8:**
> a line-by-line re-check of every §8 endpoint's request/response shape, every §9.2 event
> type against what `domain/event-stream` actually emits, and every constraint listed below
> against the corresponding code path. The items below are therefore **unverified against
> code** and should be read as the original docs-against-docs claims they always were, not
> as current fact. Treat this document as historical + partially spot-checked, not as an
> approval gate, until a full code-driven re-audit is done.

> Reviewer pass against `spec.md` §6, §8–§9, §12–§23 and the full `docs/api-reference.md`.
> Performed 2026-07-13.

## Method

Cross-checked every §8 endpoint, every §9.2 event type, every error condition the spec
names, and the §6/§12/§13/§17/§23 constraints against the api-reference. Checked for
borrowed API idioms leaking in against §2 ("not a clone").

## Findings

### Endpoints (§8)
All 37 §8 endpoints present (Agents §8.1 ×7, Environments §8.2 ×7, Sessions §8.3 ×10,
Events §8.4 ×3, Vaults §8.5 ×8, Memory §8.6 ×11, Files §8.9 ×5, Skills §8.10 ×5,
Outcomes §8.11 ×2, Jobs §8.7 ×7, Webhooks §8.8 ×5, Tenant/admin §8.12 ×4 — some overlap).
No missing endpoints.

### Event catalog (§9.2)
All persisted event types present and marked FINAL (per decisions.md item 1). Stream-only
`event_start`/`event_delta` documented as the exception to `{domain}.{action}`. `processedAt`
(null = queued) noted.

### Error taxonomy
All 13 codes present: `invalid_request`, `not_found`, `unauthorized`, `forbidden`,
`conflict`, `rate_limited`, `payload_too_large`, `internal_error`, `resource_archived`,
`budget_exhausted`, `requires_action`, `session_not_idle`, `idempotency_conflict`. HTTP
status mapping present.

### Constraints
- §6.3 budget → server-side `budget` field + `budget_exhausted` stop ✓
- §6.3 session state machine (idle→running→rescheduling→terminated) ✓
- §6.3 agent-field three forms + override semantics (omit/null/value) ✓
- §6.3 fork = new resource sharing JSONL tree (§30 item 8) ✓
- §9.3 SSE `Last-Event-ID` replay; deltas never replayed ✓
- §9.6 `system.message` not model-dependent; rejected while `requires_action` ✓
- §10.4 self-hosted unsupported matrix (no memory, no env-var creds) ✓
- §12.4 write-only sensitive fields; unique key; max 20 creds ✓
- §13.4 `contentSha256` optimistic concurrency ✓
- §13.5 versions survive deletion; 30-day retention ✓
- §13.6 redact head-of-live rejected ✓
- §17.8 exactly-once `(job_id, scheduled_at)` ✓
- §22.1 built-ins default `always_allow`, MCP default `always_ask` ✓
- §23.5 auto-disable (~20 failures / private-IP / redirect) ✓

### Borrowed-API check (§2)
No third-party endpoint paths, event-type strings, or schemas leaked in. Provider names
appear only as legitimate model provider values (`{"provider": …}`) — not an API
clone. The §9.6 note explicitly makes `system.message` provider-agnostic (not
model-dependent in Pi). ✓

## Defects (2026-07-13 pass)
None found — but see the retraction banner at the top of this document: this pass could not
find implementation defects because no implementation existed yet. It is **not** an
approval of the shipped wire contract. The SSE-path contradiction this exact method missed
is documented above as the concrete counterexample.

## Notes for implementers
- The §9.2 catalog uses wildcard families (`session.thread_*`, `session.outcome_evaluation_*`,
  `span.outcome_evaluation_*`); concrete subtypes are enumerated where the spec names them
  (§18.6 thread events, §16.5 outcome transitions) — WP-0.9 should model these as string
  literal unions with a catch-all for forward-compat.
- `whsec_` (webhook signing secret) and `apikey_` (API key ID) prefixes are implied by §23.3
  and §8.12, not enumerated in §6.6; included in the ID-format section.
