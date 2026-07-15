-- Up Migration

-- Backfill the file-storage byte counter (ROB-15, spec §27.3).
--
-- ROB-15 moves file storage from a racy pre-flight SUM(size_bytes) onto the same
-- atomic `tenant_quota_counters` reservation as the R5.2 count dimensions:
-- `domain/file` `uploadFile` reserves the real buffered byte length via
-- `reserveQuotaDelta(..., 'maxFileStorageBytes', bytes)` inside the create
-- transaction, and `deleteFile` releases it. The counter row for this resource
-- holds a raw byte total (no scaling; `bigint` fits it).
--
-- Seed each tenant's counter from the current SUM(size_bytes) — the exact value
-- the retired pre-flight read (getCurrentUsage / usageFileStorage in
-- domain/quota/enforce.ts) — so an existing deployment starts at its real usage.
-- An empty counter would hand every tenant a fresh full allowance at cutover.
-- Tenants with no files are intentionally omitted (their counter row is created
-- on first upload, starting at 0).
--
-- Drift (a reserve that commits before the row is durably inserted and then
-- crashes; a missed release) is corrected by reconcileQuotaCounter(), which
-- resets the counter to this same SUM.
INSERT INTO tenant_quota_counters (tenant_id, resource, count)
SELECT tenant_id, 'maxFileStorageBytes', COALESCE(SUM(size_bytes), 0)
  FROM files
 GROUP BY tenant_id
ON CONFLICT (tenant_id, resource) DO NOTHING;

-- Down Migration

DELETE FROM tenant_quota_counters WHERE resource = 'maxFileStorageBytes';
