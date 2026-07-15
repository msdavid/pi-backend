-- Up Migration
--
-- Row-level security backstop (R-audit SEC-10). The app-layer `tenantScoped*` guard
-- (infra/db/tenant-scoped.ts) remains the primary, always-on control; RLS is a
-- DB-enforced defense-in-depth net so that even a hand-written query that slips past
-- the guard cannot read or write another tenant's rows.
--
-- Model: the `tenantScoped*` helpers set `app.current_tenant` via `SET LOCAL` inside a
-- transaction, so every tenant-scoped query is pinned to its tenant at the database.
-- The audited cross-tenant SYSTEM queries (boot recovery, key rotation, scheduler /
-- webhook / work-queue sweeps, onboarding sign-up) deliberately do NOT set the GUC, so
-- the policy is permissive when it is unset — those paths keep working unchanged.
--
-- IMPORTANT: superusers and BYPASSRLS roles bypass RLS entirely, so for this backstop
-- to take effect the application's database role MUST be a non-superuser, non-BYPASSRLS
-- role (see docs/deploy.md). `FORCE ROW LEVEL SECURITY` additionally subjects the table
-- owner to its own policies.

CREATE OR REPLACE FUNCTION app_tenant_visible(row_tenant text) RETURNS boolean AS $$
  SELECT current_setting('app.current_tenant', true) IS NULL
      OR current_setting('app.current_tenant', true) = ''
      OR row_tenant = current_setting('app.current_tenant', true)
$$ LANGUAGE sql STABLE;

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'agents','agent_versions','api_keys','environments','files','idempotency_keys',
    'job_runs','jobs','memory_stores','memory_versions','onboarding_signups',
    'self_hosted_work_queue','session_events','session_outcomes','sessions',
    'session_threads','skills','skill_versions','tenant_quota_counters',
    'usage_records','vault_credentials','vaults','webhook_deliveries','webhooks'
  ]) LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING (app_tenant_visible(tenant_id)) '
      'WITH CHECK (app_tenant_visible(tenant_id))', t);
  END LOOP;
END $$;

-- Down Migration

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'agents','agent_versions','api_keys','environments','files','idempotency_keys',
    'job_runs','jobs','memory_stores','memory_versions','onboarding_signups',
    'self_hosted_work_queue','session_events','session_outcomes','sessions',
    'session_threads','skills','skill_versions','tenant_quota_counters',
    'usage_records','vault_credentials','vaults','webhook_deliveries','webhooks'
  ]) LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS app_tenant_visible(text);
