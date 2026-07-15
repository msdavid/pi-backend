-- Up Migration

-- Multi-host sandbox pool (§7.2, WP-4.3).
--
-- Infra-scoped control-plane state, NOT tenant-scoped: the host pool is shared across
-- all tenants (§7.2). The single-host v1 (§7.2 "single-node") is the
-- MicrosandboxProvider; this WP adds the multi-host scheduler that the backend owns.
--
-- sandbox_hosts       : the registry of KVM-capable hosts + capacity + liveness.
-- sandbox_host_placements : owner map — which host runs which microVM (for routing +
--                       boot-time re-attach across hosts, §4.2).

CREATE TABLE sandbox_hosts (
  id              text        PRIMARY KEY,                -- host_… prefixed (§6.6)
  endpoint        text        NOT NULL,                   -- https://<host>:<port> (host agent)
  cpus            integer     NOT NULL,                   -- total CPU capacity (cores)
  memory_mib      integer     NOT NULL,                   -- total memory capacity (MiB)
  status          text        NOT NULL DEFAULT 'healthy', -- healthy | unhealthy | drained
  labels          jsonb       NOT NULL DEFAULT '{}',      -- placement constraints (§4.2)
  last_heartbeat  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Look up a host by id (routing) and list healthy hosts for placement scans.
CREATE INDEX idx_sandbox_hosts_status ON sandbox_hosts (status);

-- Owner map: a microVM (addressed by its tenant-namespaced msb name, §10.1) runs on
-- exactly one host. Rows are created at provision time and reconciled at re-attach.
CREATE TABLE sandbox_host_placements (
  sandbox_name   text        PRIMARY KEY,                -- msb VM name (§10.1, §27.2)
  host_id        text        NOT NULL REFERENCES sandbox_hosts(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Count placements per host for least-loaded placement (§4.2).
CREATE INDEX idx_sandbox_host_placements_host ON sandbox_host_placements (host_id);

-- Down Migration

DROP TABLE IF EXISTS sandbox_host_placements CASCADE;
DROP TABLE IF EXISTS sandbox_hosts CASCADE;
