-- Up Migration

-- Grandfather pre-scope-enforcement API keys (R0.1) to admin. Before the
-- requireScopeByMethod route guard shipped, no route checked `api_keys.scopes`,
-- so every existing key behaved as tenant-admin regardless of what (if
-- anything) was stored. A stored `[]` is therefore the legacy "no scopes
-- recorded" state, not an intentional least-privilege grant — backfill it to
-- `["admin"]` so existing integrations keep working under the new guard. Keys
-- issued after this migration get an explicit scope (public issuance defaults
-- to `["read"]`; internal/bootstrap issuance defaults to `["admin"]`, see
-- `domain/tenant/api-key.ts` `issueApiKey`).
UPDATE api_keys SET scopes = '["admin"]'::jsonb WHERE scopes = '[]'::jsonb;

-- Down Migration

-- Irreversible by design: once backfilled, a `["admin"]` row is indistinguishable
-- from a key legitimately issued with admin scope after this migration ran, so
-- reverting to `[]` would strip scope from real admin keys. This is a no-op;
-- rolling back only removes 028 from the migrations ledger.
