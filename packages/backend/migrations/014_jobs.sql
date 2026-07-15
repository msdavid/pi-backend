-- Up Migration

-- Scheduled jobs (§3.9). Archive is terminal/immutable; auto-archive when the
-- job's agent is archived (§17.5). Max 1,000 jobs per tenant (app-enforced, §17.3).
CREATE TABLE jobs (
  tenant_id        text        NOT NULL REFERENCES tenants(id),
  id               text        PRIMARY KEY,          -- job_… prefixed
  name             text        NOT NULL,             -- 1–128 chars
  agent_id         text        NOT NULL REFERENCES agents(id),
  agent_version    integer     NOT NULL,             -- pinned at creation (§17.1)
  environment_id   text        NOT NULL REFERENCES environments(id),
  initial_events   jsonb       NOT NULL,             -- a user.message event — required (§17.1)
  session_config   jsonb       NOT NULL DEFAULT '{}', -- resources, vaultIds, … (§17.1)
  schedule_cron    text        NOT NULL,             -- POSIX cron (§17.2)
  schedule_tz      text        NOT NULL,             -- IANA timezone (§17.2)
  one_shot         boolean     NOT NULL DEFAULT false, -- single-fire delegation jobs (§14.4, §17.8)
  status           text        NOT NULL DEFAULT 'active', -- active | paused | archived (§17.5)
  paused_reason    jsonb,                              -- {type:'manual'} | {type:'error',error:{…}} (§17.5, §17.6)
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_jobs_tenant_id_name ON jobs (tenant_id, name);
CREATE INDEX idx_jobs_tenant_id ON jobs (tenant_id);

-- Down Migration

DROP TABLE IF EXISTS jobs CASCADE;
