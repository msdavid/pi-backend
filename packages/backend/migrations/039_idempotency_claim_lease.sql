-- Up Migration

-- ROB-12 — Idempotency claim lease (crash recovery).
--
-- The claim-first preHandler inserts a placeholder row (response_status = 0,
-- expires_at = +24h) and relies on the onSend hook to overwrite it with the
-- real response (2xx) or DELETE it (error). A crash/OOM between the claim and
-- onSend — or a swallowed storeResponse failure after a 2xx — leaves the row
-- stuck at status 0: every retry of the same key then 409s "request in
-- progress" until the 24h TTL expires.
--
-- `claimed_at` records when the placeholder was claimed. A claim older than a
-- short lease (a few minutes — far longer than any real handler) is treated as
-- abandoned and atomically reclaimed by the next retry (mirrors the
-- webhook_deliveries / job_runs `claimed_at` CAS from 033/034). Only in-flight
-- rows (response_status = 0) are ever reclaimed; a finished stored response is
-- immutable within its retention window.
ALTER TABLE idempotency_keys
  ADD COLUMN claimed_at timestamptz NOT NULL DEFAULT now();

-- Down Migration

ALTER TABLE idempotency_keys DROP COLUMN IF EXISTS claimed_at;
