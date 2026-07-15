-- Up Migration

-- Credential-issuing routes must never have their response body persisted
-- (§25.1, §8: raw `pmb_live_` keys and `whsec_` signing secrets are shown once,
-- never stored). The idempotency middleware records those keys with a NULL
-- body — the key + request-body hash + status still support dedup/conflict
-- detection, while a replay yields 409 idempotency_conflict instead of
-- re-serving a secret. `response_body` therefore becomes nullable.
ALTER TABLE idempotency_keys ALTER COLUMN response_body DROP NOT NULL;

-- Purge bodies already persisted under the old behaviour: any row stored before
-- this migration may contain a live API key or webhook signing secret in
-- plaintext. Dropping every body is safe — a replay of a non-credential key now
-- 409s instead of replaying, which is the conservative outcome.
UPDATE idempotency_keys SET response_body = NULL;

-- Down Migration

DELETE FROM idempotency_keys WHERE response_body IS NULL;
ALTER TABLE idempotency_keys ALTER COLUMN response_body SET NOT NULL;
