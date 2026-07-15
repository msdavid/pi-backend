/**
 * compileProvisionSpec unit tests (WP-1.2).
 *
 * Pure (no DB). Asserts the network-policy mapping is faithful to §10.5:
 * - `unrestricted` → `{ mode: "unrestricted" }` — NOT an allow-all. The provider
 *   applies `publicOnly()`; the spec must never degrade to a permissive allow-all.
 * - `limited` → `{ mode: "limited", allowedHosts }` — default-deny + explicit hosts.
 * - labels carry `{ tenant, session }`; `detached` is true; `secretBindings`
 *   are NOT populated (vault resolver owns that in WP-1.9/1.5).
 */

import { describe, expect, it } from "vitest";
import {
  compileProvisionSpec,
  compileNetworkPolicy,
  compileVolumeMounts,
} from "../compile-spec.js";
import type { Environment } from "@pi-managed/contracts";
import type { ProvisionSpec } from "../../ports.js";

const baseEnv: Environment = {
  id: "env_01J",
  name: "python-env",
  type: "cloud",
  image: "ubuntu:22.04",
  resources: { cpus: 2, memoryMiB: 2048, diskMiB: 10240 },
  networking: { mode: "unrestricted" },
  packages: ["python3"],
  mounts: [],
  status: "active",
  metadata: {},
  createdAt: "2026-07-13T12:00:00.000Z",
  updatedAt: "2026-07-13T12:00:00.000Z",
};

const ctx = { tenantId: "tnt_01J", sessionId: "sess_01J" };

describe("compileNetworkPolicy", () => {
  it("unrestricted maps to {mode:'unrestricted'} — NOT allowAll", () => {
    const policy = compileNetworkPolicy({
      ...baseEnv,
      networking: { mode: "unrestricted" },
    });
    expect(policy).toEqual({ mode: "unrestricted" });
    // The discriminated union must be the unrestricted branch, not a permissive
    // allow-all: there is NO `allowedHosts` field and mode is exactly "unrestricted".
    expect(policy.mode).toBe("unrestricted");
    expect("allowedHosts" in policy).toBe(false);
  });

  it("missing networking defaults to unrestricted (NOT allowAll)", () => {
    const env = { ...baseEnv } as Environment;
    delete env.networking;
    const policy = compileNetworkPolicy(env);
    expect(policy).toEqual({ mode: "unrestricted" });
  });

  it("limited carries allowedHosts (default-deny + explicit allows)", () => {
    const policy = compileNetworkPolicy({
      ...baseEnv,
      networking: { mode: "limited", allowedHosts: ["github.com", "pypi.org"] },
    });
    expect(policy).toEqual({
      mode: "limited",
      allowedHosts: ["github.com", "pypi.org"],
    });
  });
});

describe("compileVolumeMounts", () => {
  it("resolves each variant to a tenant-scoped source + managed guest path", () => {
    const mounts = compileVolumeMounts(
      {
        ...baseEnv,
        mounts: [
          { type: "memory_store", id: "mem_01JQ" },
          { type: "file", id: "file_01JQ", destination: "/mnt/data" },
          // `staged` is the only repo mode that is a VOLUME (§25.2); an `egress` repo is
          // cloned inside the guest and has nothing to bind.
          { type: "repo", url: "https://github.com/acme/repo.git", clone: "staged" },
        ],
      },
      ctx,
    );
    expect(mounts).toEqual([
      { guestPath: "/mnt/memory/mem_01JQ/", source: "tenants/tnt_01J/memory/mem_01JQ", readOnly: true },
      { guestPath: "/mnt/data", source: "tenants/tnt_01J/files/file_01JQ", readOnly: true },
      {
        guestPath: "/mnt/repos/https-github-com-acme-repo-git/",
        source: "tenants/tnt_01J/repos/https-github-com-acme-repo-git",
        readOnly: true,
      },
    ]);
  });

  it("an egress repo mount produces NO volume (it is cloned in-guest, §25.2)", () => {
    const mounts = compileVolumeMounts(
      {
        ...baseEnv,
        mounts: [{ type: "repo", url: "https://github.com/acme/repo.git" }],
      },
      ctx,
    );
    expect(mounts).toEqual([]);
  });

  it("defaults to read-only; read-write requires explicit readOnly:false", () => {
    const mounts = compileVolumeMounts(
      {
        ...baseEnv,
        mounts: [
          { type: "memory_store", id: "mem_ro" },
          { type: "file", id: "file_rw", readOnly: false },
        ],
      },
      ctx,
    );
    expect(mounts[0].readOnly).toBe(true);
    expect(mounts[1].readOnly).toBe(false);
  });

  it("fails closed on a legacy/raw-source row (never reaches .bind())", () => {
    const mounts = compileVolumeMounts(
      {
        ...baseEnv,
        mounts: [{ source: "/", destination: "/host" }],
      } as unknown as Environment,
      ctx,
    );
    expect(mounts).toEqual([]);
  });

  it("returns [] for no mounts", () => {
    expect(compileVolumeMounts(baseEnv, ctx)).toEqual([]);
  });
});

describe("compileProvisionSpec", () => {
  it("assembles a detached, labeled spec with resources + image", () => {
    const spec: ProvisionSpec = compileProvisionSpec(baseEnv, ctx);
    expect(spec.cpus).toBe(2);
    expect(spec.memoryMiB).toBe(2048);
    expect(spec.diskMiB).toBe(10240);
    expect(spec.image).toBe("ubuntu:22.04");
    expect(spec.detached).toBe(true);
    expect(spec.labels).toEqual({ tenant: "tnt_01J", session: "sess_01J" });
    // name is tenant/session-namespaced and microsandbox-safe (lowercase, hyphenated).
    expect(spec.name).toMatch(/^[a-z0-9-]+$/);
    expect(spec.name).toContain("tnt");
    expect(spec.name).toContain("sess");
  });

  it("networkPolicy is unrestricted (NOT allowAll)", () => {
    const spec = compileProvisionSpec(
      { ...baseEnv, networking: { mode: "unrestricted" } },
      ctx,
    );
    expect(spec.networkPolicy).toEqual({ mode: "unrestricted" });
    expect("allowedHosts" in spec.networkPolicy).toBe(false);
  });

  it("networkPolicy is limited with allowedHosts", () => {
    const spec = compileProvisionSpec(
      {
        ...baseEnv,
        networking: { mode: "limited", allowedHosts: ["github.com"] },
      },
      ctx,
    );
    expect(spec.networkPolicy).toEqual({
      mode: "limited",
      allowedHosts: ["github.com"],
    });
  });

  it("does NOT populate secretBindings (vault resolver owns them)", () => {
    const spec = compileProvisionSpec(baseEnv, ctx);
    expect(spec.secretBindings).toBeUndefined();
    expect(spec.env).toBeUndefined(); // no non-secret literals in Phase 1
  });

  it("defaults cpus/memory when resources omit them", () => {
    const env = { ...baseEnv } as Environment;
    delete env.resources;
    const spec = compileProvisionSpec(env, ctx);
    expect(spec.cpus).toBeGreaterThan(0);
    expect(spec.memoryMiB).toBeGreaterThan(0);
    expect(spec.diskMiB).toBeUndefined();
  });

  it("defaults image when env.image absent", () => {
    const env = { ...baseEnv } as Environment;
    delete env.image;
    const spec = compileProvisionSpec(env, ctx);
    expect(spec.image).toBe("ubuntu:22.04");
  });

  it("includes volumes when mounts present", () => {
    const spec = compileProvisionSpec(
      {
        ...baseEnv,
        mounts: [{ type: "file", id: "file_01JQ", destination: "/mnt/b" }],
      },
      ctx,
    );
    expect(spec.volumes).toEqual([
      { guestPath: "/mnt/b", source: "tenants/tnt_01J/files/file_01JQ", readOnly: true },
    ]);
  });

  it("omits volumes when no mounts", () => {
    const spec = compileProvisionSpec(baseEnv, ctx);
    expect(spec.volumes).toBeUndefined();
  });
});
