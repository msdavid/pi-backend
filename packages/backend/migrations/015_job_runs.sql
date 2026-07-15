-- Up Migration

-- Job runs (§3.9). The UNIQUE (job_id, scheduled_at) is the exactly-once firing
-- claim (§17.8): the scheduler inserts with ON CONFLICT (job_id, scheduled_at)
-- DO NOTHING; a conflict means another loop/node already claimed this occurrence.
CREATE TABLE job_runs (
  tenant_id    text        NOT NULL REFERENCES tenants(id),
  id           text        PRIMARY KEY,
  job_id       text        NOT NULL REFERENCES jobs(id),
  scheduled_at timestamptz NOT NULL,                 -- the occurrence time
  triggered_at timestamptz,                           -- when actually fired
  session_id   text        REFERENCES sessions(id),   -- nullable; set on success (§17.4)
  manual       boolean     NOT NULL DEFAULT false,    -- §17.7
  error        jsonb,                                  -- {type} on failure (§17.4 taxonomy)
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Exactly-once claim (§17.8).
CREATE UNIQUE INDEX idx_job_runs_job_scheduled ON job_runs (job_id, scheduled_at);
CREATE INDEX idx_job_runs_tenant_created ON job_runs (tenant_id, created_at);

-- Down Migration

DROP TABLE IF EXISTS job_runs CASCADE;
