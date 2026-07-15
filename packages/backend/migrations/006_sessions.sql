-- Up Migration

-- Sessions (§3.3). Postgres holds metadata only — the JSONL conversation lives in
-- the object store at sessions.jsonl_object_key, NOT here (§28).
CREATE TABLE sessions (
  tenant_id              text        NOT NULL REFERENCES tenants(id),
  id                     text        PRIMARY KEY,  -- sess_… prefixed
  agent_id               text        NOT NULL REFERENCES agents(id),
  agent_version          integer     NOT NULL,     -- pinned at creation (§6.1)
  environment_id         text        NOT NULL REFERENCES environments(id),
  title                  text,
  status                 text        NOT NULL DEFAULT 'idle', -- idle|running|rescheduling|terminated
  stop_reason            text,                       -- requires_action|budget_exhausted|user_interrupt|error
  budget                 jsonb,                      -- {maxTokens?,maxUsd?}
  usage                  jsonb       NOT NULL DEFAULT '{}', -- cumulative token counts
  vault_ids              jsonb       NOT NULL DEFAULT '[]',  -- creds referenced per-session (§12)
  resources              jsonb       NOT NULL DEFAULT '[]',  -- files/repos/memory to mount
  agent_overrides        jsonb,                      -- overrides form of `agent` (§6.3); null if bare id
  metadata               jsonb       NOT NULL DEFAULT '{}',
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  last_activity_at       timestamptz NOT NULL DEFAULT now(), -- 30-day checkpoint + 90-day JSONL retention
  jsonl_object_key       text        NOT NULL,       -- object-store key; conversation NOT in Postgres (§28)
  forked_from_session_id text        REFERENCES sessions(id), -- non-null = fork (§6.3)
  sandbox_handle         text                         -- provider VM handle; null if never provisioned
);

CREATE INDEX idx_sessions_tenant_status       ON sessions (tenant_id, status);
CREATE INDEX idx_sessions_tenant_agent        ON sessions (tenant_id, agent_id);
CREATE INDEX idx_sessions_tenant_environment  ON sessions (tenant_id, environment_id);

-- Down Migration

DROP TABLE IF EXISTS sessions CASCADE;
