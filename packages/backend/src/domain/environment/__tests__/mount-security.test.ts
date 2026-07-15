/**
 * Mount source hardening — regression tests for R0.1 (C1, §25.1).
 *
 * The defect: `Mount.source` was an unconstrained string that flowed untouched
 * through `compileVolumeMounts` into the provider's `builder.volume(...).bind(source)`
 * — a HOST bind mount. `POST /v1/environments {"mounts":[{"source":"/"}]}` gave the
 * agent the backend host's filesystem read-write (vault key, object store, DB creds,
 * other tenants' VM disks, /dev/kvm).
 *
 * The invariant these tests pin (§25.1 — untrusted agent code cannot touch the backend
 * host and cannot read credentials):
 *  - no caller-supplied host path is accepted by the API (422);
 *  - every compiled volume `source` is a backend-derived, TENANT-SCOPED key;
 *  - mounts default to read-only (RW must be explicit).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pino from "pino";
import { createApp } from "../../../server.js";
import {
  createPool,
  closePool,
  runMigrations,
  type Pool,
} from "../../../infra/db/index.js";
import { loadConfig } from "../../../infra/config/index.js";
import { startPostgres, type TestDb } from "../../../infra/db/__tests__/test-runtime.js";
import { createTenant } from "../../tenant/tenant.js";
import { issueApiKey } from "../../tenant/api-key.js";
import { compileVolumeMounts } from "../compile-spec.js";
import type { Environment } from "@pi-managed/contracts";

/** Host paths a tenant must never be able to name as a mount source. */
const HOST_PATHS = [
  "/",
  "../",
  "../../../../etc/shadow",
  "/proc/self/environ",
  "/var/lib/pi/vault.key",
  // symlink-to-/ planted on the host: the string is opaque, so the only safe
  // rule is "no caller-supplied path at all".
  "/tmp/pwn-symlink-to-root",
];

describe("mount source hardening (HTTP, §25.1)", () => {
  let db: TestDb;
  let pool: Pool;
  let app: FastifyInstance;
  let auth: string;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
    const config = loadConfig({ env: { LOG_LEVEL: "error" } });
    app = await createApp({ config, logger: pino({ level: "error" }), pool });
    const t = await createTenant(pool, { name: "Mount Sec Tenant" });
    const issued = await issueApiKey(pool, { tenantId: t.id }, { name: "k" });
    auth = `Bearer ${issued.key}`;
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  for (const source of HOST_PATHS) {
    it(`POST /v1/environments rejects host-path mount source ${JSON.stringify(source)} → 422`, async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/environments",
        headers: {
          authorization: auth,
          "idempotency-key": `mnt-${Math.random()}`,
          "content-type": "application/json",
        },
        payload: {
          name: `pwn-${Math.random().toString(36).slice(2, 8)}`,
          type: "cloud",
          mounts: [{ source, destination: "/host" }],
        },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("invalid_request");
    });
  }

  it("PATCH /v1/environments/:id rejects a host-path mount source → 422", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/environments",
      headers: {
        authorization: auth,
        "idempotency-key": `patch-${Math.random()}`,
        "content-type": "application/json",
      },
      payload: { name: `patch-${Math.random().toString(36).slice(2, 8)}`, type: "cloud" },
    });
    expect(create.statusCode).toBe(201);
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/environments/${create.json().id}`,
      headers: { authorization: auth, "content-type": "application/json" },
      payload: { mounts: [{ source: "/", destination: "/host" }] },
    });
    expect(res.statusCode).toBe(422);
  });

  it("accepts a backend-managed mount target (memory_store) → 201", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/environments",
      headers: {
        authorization: auth,
        "idempotency-key": `ok-${Math.random()}`,
        "content-type": "application/json",
      },
      payload: {
        name: `ok-${Math.random().toString(36).slice(2, 8)}`,
        type: "cloud",
        mounts: [{ type: "memory_store", id: "mem_01JQ" }],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().mounts).toEqual([{ type: "memory_store", id: "mem_01JQ" }]);
  });

  it("rejects a guest destination outside /mnt (escaping the managed root) → 422", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/environments",
      headers: {
        authorization: auth,
        "idempotency-key": `dest-${Math.random()}`,
        "content-type": "application/json",
      },
      payload: {
        name: `dest-${Math.random().toString(36).slice(2, 8)}`,
        type: "cloud",
        mounts: [
          { type: "file", id: "file_01JQ", destination: "/mnt/../etc/ssh" },
        ],
      },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe("compileVolumeMounts (§25.1 — no caller path reaches .bind())", () => {
  const ctx = { tenantId: "tnt_01J", sessionId: "sess_01J" };
  const baseEnv: Environment = {
    id: "env_01J",
    name: "e",
    type: "cloud",
    status: "active",
    createdAt: "2026-07-13T12:00:00.000Z",
    updatedAt: "2026-07-13T12:00:00.000Z",
  };

  it("drops legacy DB rows carrying a raw host-path source", () => {
    // Rows written before this fix are jsonb and are NOT re-validated on read;
    // the compiler must fail closed on them.
    const env = {
      ...baseEnv,
      mounts: [{ source: "/", destination: "/host" }],
    } as unknown as Environment;
    expect(compileVolumeMounts(env, ctx)).toEqual([]);
  });

  it("resolves every source under the tenant-scoped root and defaults to read-only", () => {
    const env = {
      ...baseEnv,
      mounts: [
        { type: "memory_store", id: "mem_01JQ" },
        { type: "file", id: "file_01JQ", readOnly: false },
        // Only a `staged` repo is a volume (§25.2); an `egress` repo is cloned in-guest.
        { type: "repo", url: "https://github.com/acme/repo.git", clone: "staged" },
      ],
    } as Environment;
    const volumes = compileVolumeMounts(env, ctx);
    expect(volumes).toHaveLength(3);
    for (const v of volumes) {
      expect(v.source.startsWith(`tenants/${ctx.tenantId}/`)).toBe(true);
      expect(v.source).not.toContain("..");
      expect(v.guestPath.startsWith("/mnt/")).toBe(true);
    }
    expect(volumes[0].readOnly).toBe(true); // default read-only
    expect(volumes[1].readOnly).toBe(false); // RW only when explicit
    expect(volumes[2].readOnly).toBe(true);
  });
});
