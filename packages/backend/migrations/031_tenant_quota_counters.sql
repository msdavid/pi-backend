-- Up Migration

-- Transactional quota counters (R5.2, spec §27.3).
--
-- One row per (tenant, count-based resource). The resource-creating path
-- increments the counter INSIDE the create transaction
-- (INSERT ... ON CONFLICT (tenant_id, resource) DO UPDATE SET count = count + 1
-- RETURNING count) and compares the returned value to the tenant's plan limit;
-- if over, the transaction ROLLs BACK (undoing the increment) and the create is
-- rejected with 429 rate_limited. The row-level lock on the primary key
-- serializes concurrent creates, so N concurrent creates admit exactly `limit` —
-- the racy preHandler COUNT that let all N pass (checkQuota) is retired for the
-- count-based dimensions. File storage stays a SUM(size_bytes) check (not a
-- counter), so it is intentionally absent here.
--
-- Decremented (GREATEST(count - 1, 0)) on resource deletion/termination and as
-- compensation when a reserved create fails before its row is durably inserted.
CREATE TABLE tenant_quota_counters (
  tenant_id text   NOT NULL REFERENCES tenants(id),
  resource  text   NOT NULL,          -- QuotaResource name: concurrentSessions | maxJobs | maxVaultCredentials | maxMemoryStores
  count     bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, resource)
);

-- Backfill from the rows the pre-flight COUNT used to read, so an existing
-- deployment's counters start at its real usage (an empty counter would hand
-- every over-quota tenant a fresh allowance at cutover). Same predicates as
-- getCurrentUsage() in domain/quota/enforce.ts.
INSERT INTO tenant_quota_counters (tenant_id, resource, count)
SELECT tenant_id, 'concurrentSessions', COUNT(*)
  FROM sessions
 WHERE status IN ('idle', 'running', 'rescheduling')
 GROUP BY tenant_id
ON CONFLICT (tenant_id, resource) DO NOTHING;

INSERT INTO tenant_quota_counters (tenant_id, resource, count)
SELECT tenant_id, 'maxJobs', COUNT(*)
  FROM jobs
 WHERE status <> 'archived'
 GROUP BY tenant_id
ON CONFLICT (tenant_id, resource) DO NOTHING;

-- Down Migration

DROP TABLE IF EXISTS tenant_quota_counters CASCADE;
