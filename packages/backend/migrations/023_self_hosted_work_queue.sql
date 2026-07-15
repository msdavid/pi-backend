-- Up Migration

-- Self-hosted work queue (§10.4, WP-4.1).
--
-- When a session is assigned to a `self_hosted` environment, a work item is
-- enqueued here instead of provisioning a cloud sandbox (§10.4). A worker
-- claims the next item (`FOR UPDATE SKIP LOCKED`), runs tools locally on the
-- subscriber host, and posts results back as `user.tool_result` events (§9.2).
--
-- One work item per self-hosted session (session_id is unique). The work item
-- carries the initial events + config in `work_spec`; tool results posted by
-- the worker are appended to `results` (the authoritative conversation log lives
-- in the object store, §28 — this column is the worker→control-plane channel).
CREATE TABLE self_hosted_work_queue (
  tenant_id          text        NOT NULL REFERENCES tenants(id),
  id                  text        PRIMARY KEY,            -- work_… prefixed
  session_id          text        NOT NULL REFERENCES sessions(id),
  environment_id      text        NOT NULL REFERENCES environments(id),
  status              text        NOT NULL DEFAULT 'queued', -- queued | claimed | done | stopped
  work_spec           jsonb       NOT NULL,                -- initial events + config (§10.4)
  results             jsonb       NOT NULL DEFAULT '[]',   -- user.tool_result events posted by the worker (§9.2)
  claimed_by          text,                                 -- apikey_… worker key id (NULL while queued)
  claimed_at          timestamptz,
  queued_at           timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  stop_requested      text,                                 -- NULL | 'clean' | 'force' (§10.4 work.stop)
  stop_requested_at   timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- One work item per session (a self-hosted session maps to exactly one item).
CREATE UNIQUE INDEX idx_self_hosted_work_queue_session
  ON self_hosted_work_queue (session_id);
-- The claim query scans `(environment_id, status='queued')` ordered by queued_at.
CREATE INDEX idx_self_hosted_work_queue_env_status
  ON self_hosted_work_queue (environment_id, status, queued_at);
CREATE INDEX idx_self_hosted_work_queue_tenant ON self_hosted_work_queue (tenant_id);

-- Down Migration

DROP TABLE IF EXISTS self_hosted_work_queue CASCADE;
