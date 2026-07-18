-- Up Migration

-- Console sessions (WP-C1.2, console spec §4.7). Binds a browser cookie to a
-- validated API key so the web console never holds the key in JS-readable
-- storage (console spec §4.1). Storage is a Postgres table (decided,
-- tmp/console.md §10.1): sign-out and key revocation delete/deny server-side
-- state immediately, and the sliding TTL (§4.6) is a column update. The raw
-- session token is NEVER stored — only its SHA-256 hash (a leaked table row
-- cannot be replayed as a cookie).
CREATE TABLE console_sessions (
  token_hash   text        PRIMARY KEY,             -- SHA-256 hex of the cookie token
  api_key_id   text        NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  tenant_id    text        NOT NULL REFERENCES tenants(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,                -- sliding TTL (console spec §4.6)
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_console_sessions_tenant_id ON console_sessions (tenant_id);
CREATE INDEX idx_console_sessions_api_key_id ON console_sessions (api_key_id);
-- Expiry sweep (opportunistic DELETE on session create) scans by expires_at.
CREATE INDEX idx_console_sessions_expires_at ON console_sessions (expires_at);

-- Row-level security backstop, matching migration 040 (SEC-10): permissive when
-- `app.current_tenant` is unset (the pre-auth session-resolution path), pinned
-- to the tenant whenever a tenant-scoped query sets the GUC.
ALTER TABLE console_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE console_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON console_sessions
  USING (app_tenant_visible(tenant_id))
  WITH CHECK (app_tenant_visible(tenant_id));

-- Down Migration

DROP TABLE IF EXISTS console_sessions CASCADE;
