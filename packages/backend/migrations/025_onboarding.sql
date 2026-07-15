-- Up Migration

-- Onboarding sign-ups (WP-5.2, §29.6). Maps admin email → tenant so
-- `POST /v1/onboarding/signup` is idempotent on `adminEmail`: a repeated
-- sign-up reuses the existing tenant instead of creating a duplicate. The raw
-- API key is NEVER stored here (it is hashed in `api_keys`, §8) — this table
-- only records the email → tenant linkage for idempotent lookup.
CREATE TABLE onboarding_signups (
  admin_email text        PRIMARY KEY,
  tenant_id   text        NOT NULL REFERENCES tenants(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_onboarding_signups_tenant_id ON onboarding_signups (tenant_id);

-- Down Migration

DROP TABLE IF EXISTS onboarding_signups CASCADE;
