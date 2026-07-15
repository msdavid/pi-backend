-- Up Migration

-- Multi-agent threads (§3.12, Phase 3 — stub now). Max 25 concurrent threads
-- per session (§18.5).
CREATE TABLE session_threads (
  tenant_id  text        NOT NULL REFERENCES tenants(id),
  session_id text        NOT NULL REFERENCES sessions(id),
  thread_id  text        NOT NULL,
  agent_name text        NOT NULL,                  -- §18.3
  status     text        NOT NULL,                  -- running | idle | terminated (§18.5)
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, thread_id)
);

CREATE INDEX idx_session_threads_tenant_session ON session_threads (tenant_id, session_id);

-- Down Migration

DROP TABLE IF EXISTS session_threads CASCADE;
