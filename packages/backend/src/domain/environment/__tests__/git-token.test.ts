/**
 * Git-token clone path (R6.8, §25.2) — the credential-injection gate for git.
 *
 * The invariant under test: a repo can be cloned into the sandbox WITHOUT the token ever
 * landing in the guest. Concretely, the guest-readable surface — the clone command, the
 * `.git/config` remote URL git writes from it, the guest env, and the whole
 * {@link ProvisionSpec} the harness handles — must contain the `$MSB_GIT_TOKEN_<slug>`
 * placeholder and NEVER the PAT. An agent running `git remote -v` / `cat .git/config` /
 * `env` learns nothing.
 *
 * The DB half (skipped without a container runtime) drives the real resolution path:
 * a real encrypted PAT in a real vault → `createVaultSecretStore` bindings →
 * `createVaultSecretResolver` decryption. The store's bindings are what the session
 * manager hands the provider, so grepping them for the plaintext is the actual gate.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Environment } from "@pi-managed/contracts";
import {
  closePool,
  createPool,
  query,
  runMigrations,
  type Pool,
  type TenantCtx,
} from "../../../infra/db/index.js";
import {
  hasContainerRuntime,
  startPostgres,
  type TestDb,
} from "../../../infra/db/__tests__/test-runtime.js";
import { createTenant } from "../../tenant/tenant.js";
import { createVault } from "../../vault/vault.js";
import { addCredential } from "../../vault/credential.js";
import { createVaultCrypto } from "../../vault/crypto.js";
import { createVaultSecretStore } from "../../vault/secret-store.js";
import { createVaultSecretResolver } from "../../vault/secret-resolver.js";
import { guestCloneExec } from "../../../infra/sandbox/provider.js";
import {
  compileGitTokenBindings,
  compileProvisionSpec,
  compileRepoClones,
  compileVolumeMounts,
  gitTokenPlaceholder,
  placeholderCloneUrl,
} from "../compile-spec.js";

/** The PAT under test. If this string is ever guest-visible, the gate has failed. */
const PAT = "ghp_TOTALLY_SECRET_TOKEN_VALUE_0123456789";
const REPO_URL = "https://github.com/acme/repo.git";
const PLACEHOLDER = gitTokenPlaceholder(REPO_URL);

const ctx = { tenantId: "tnt_git", sessionId: "sess_git" };

function envWithRepo(repo: Record<string, unknown>): Environment {
  return {
    id: "env_git",
    name: "git-env",
    type: "cloud",
    image: "ubuntu:22.04",
    resources: { cpus: 1, memoryMiB: 512 },
    networking: { mode: "limited", allowedHosts: ["github.com"] },
    mounts: [repo],
    status: "active",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
  } as unknown as Environment;
}

const AUTH = {
  type: "git_token",
  vaultId: "vault_01J",
  credentialKey: "github-pat",
} as const;

describe("§25.2 egress clone — the guest holds a placeholder, never the token", () => {
  it("compiles a git_token binding scoped to the repo's git host, with no value", () => {
    const bindings = compileGitTokenBindings(
      envWithRepo({ type: "repo", url: REPO_URL, auth: AUTH }),
      ctx,
    );
    expect(bindings).toEqual([
      {
        placeholderName: PLACEHOLDER,
        category: "git_token",
        credentialRef: {
          tenantId: "tnt_git",
          vaultId: "vault_01J",
          credentialKey: "github-pat",
        },
        // The ONLY host the token may ever be substituted toward (§25.4).
        allowedHosts: ["github.com"],
      },
    ]);
  });

  it("the clone URL (what git writes into .git/config) carries only the placeholder", () => {
    const url = placeholderCloneUrl(REPO_URL, PLACEHOLDER);
    expect(url).toBe(`https://x-access-token:${PLACEHOLDER}@github.com/acme/repo.git`);
    // The guest-readable git config is exactly this string — grep it for the PAT.
    expect(url).not.toContain(PAT);
    expect(url).toContain("$MSB_GIT_TOKEN_");
  });

  it("the in-guest clone exec carries no secret material (cmd + env)", () => {
    const [repo] = compileRepoClones(
      envWithRepo({ type: "repo", url: REPO_URL, auth: AUTH }),
      ctx,
    );
    expect(repo).toMatchObject({ mode: "egress", tokenPlaceholder: PLACEHOLDER });

    const exec = guestCloneExec(repo);
    const serialized = JSON.stringify(exec);
    expect(serialized).not.toContain(PAT);
    expect(serialized).toContain(PLACEHOLDER);
    expect(exec.cmd).toEqual([
      "git",
      "clone",
      "--",
      `https://x-access-token:${PLACEHOLDER}@github.com/acme/repo.git`,
      "/mnt/repos/https-github-com-acme-repo-git/",
    ]);
    // Never prompt: a denied credential must fail the provision, not hang it.
    expect(exec.env).toEqual({ GIT_TERMINAL_PROMPT: "0" });
  });

  it("an egress repo is cloned in-guest — it is NOT a bind mount", () => {
    const env = envWithRepo({ type: "repo", url: REPO_URL, auth: AUTH });
    expect(compileVolumeMounts(env, ctx)).toEqual([]);
    const spec = compileProvisionSpec(env, ctx);
    expect(spec.volumes).toBeUndefined();
    expect(spec.repos).toHaveLength(1);
    // The whole spec the harness handles is free of credential material (§25.5): the
    // token exists only inside the vault + microsandbox's host-side secret store.
    expect(JSON.stringify(spec)).not.toContain(PAT);
  });

  it("a public repo (no auth) compiles to a clone with no placeholder at all", () => {
    const [repo] = compileRepoClones(envWithRepo({ type: "repo", url: REPO_URL }), ctx);
    expect(repo.tokenPlaceholder).toBeUndefined();
    expect(guestCloneExec(repo).cmd).toEqual([
      "git",
      "clone",
      "--",
      REPO_URL,
      "/mnt/repos/https-github-com-acme-repo-git/",
    ]);
  });
});

describe("§25.2 staged fallback — host-side clone, read-only mount, no push", () => {
  const stagedEnv = envWithRepo({
    type: "repo",
    url: REPO_URL,
    auth: AUTH,
    clone: "staged",
    // Even an explicit read-write request cannot make the staged mount writable.
    readOnly: false,
  });

  it("mounts the staged clone READ-ONLY under the tenant-scoped repo root", () => {
    expect(compileVolumeMounts(stagedEnv, ctx)).toEqual([
      {
        guestPath: "/mnt/repos/https-github-com-acme-repo-git/",
        source: "tenants/tnt_git/repos/https-github-com-acme-repo-git",
        readOnly: true,
      },
    ]);
  });

  it("resolves the token host-side only — no binding, so no placeholder in the guest", () => {
    // No git_token binding: the guest never holds any credential on this path, which is
    // exactly why push is unsupported here.
    expect(compileGitTokenBindings(stagedEnv, ctx)).toEqual([]);
    const [repo] = compileRepoClones(stagedEnv, ctx);
    expect(repo).toEqual({
      url: REPO_URL,
      guestPath: "/mnt/repos/https-github-com-acme-repo-git/",
      mode: "staged",
      volumeSource: "tenants/tnt_git/repos/https-github-com-acme-repo-git",
      credentialRef: {
        tenantId: "tnt_git",
        vaultId: "vault_01J",
        credentialKey: "github-pat",
      },
    });
    expect(repo.tokenPlaceholder).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Real resolution path (Postgres): vault → SecretStore bindings → resolver.
// ---------------------------------------------------------------------------

const RUNTIME = hasContainerRuntime();
const KEY = Buffer.alloc(32, 9);
const CRYPTO = createVaultCrypto(KEY, "test");

describe.skipIf(!RUNTIME)("git_token bindings resolve from a real vault (§25.2/§25.5)", () => {
  let db: TestDb;
  let pool: Pool;
  let tenantCtx: TenantCtx;
  let vaultId: string;
  let sessionId: string;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(pool);

    const tenant = await createTenant(pool, { name: "git-token-test" });
    tenantCtx = { tenantId: tenant.id, scopes: ["admin"] };

    const vault = await createVault(pool, tenantCtx, { name: "git-vault" });
    vaultId = vault.id;
    await addCredential(pool, tenantCtx, CRYPTO, vaultId, {
      key: "github-pat",
      category: "environment_variable",
      secretValue: PAT,
    });

    // An environment whose repo mount references that credential, and a session on it.
    const envId = `env_${randomUUID()}`;
    await query(
      pool,
      `INSERT INTO environments (tenant_id, id, name, type, image, resources, networking, mounts)
       VALUES ($1, $2, $3, 'cloud', 'ubuntu:22.04', '{}', '{"mode":"unrestricted"}', $4::jsonb)`,
      [
        tenantCtx.tenantId,
        envId,
        `env-${envId}`,
        JSON.stringify([
          { type: "repo", url: REPO_URL, auth: { ...AUTH, vaultId } },
        ]),
      ],
    );
    const agentId = `agent_${randomUUID()}`;
    await query(pool, `INSERT INTO agents (tenant_id, id, name) VALUES ($1, $2, $3)`, [
      tenantCtx.tenantId,
      agentId,
      `agent-${agentId}`,
    ]);
    sessionId = `sess_${randomUUID()}`;
    await query(
      pool,
      `INSERT INTO sessions (tenant_id, id, agent_id, agent_version, environment_id, jsonl_object_key)
       VALUES ($1, $2, $3, 1, $4, $5)`,
      [tenantCtx.tenantId, sessionId, agentId, envId, `key-${sessionId}`],
    );
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  it("emits a value-free git_token binding for a session with NO vaultIds", async () => {
    const store = createVaultSecretStore(pool, { crypto: CRYPTO });
    const bindings = await store.resolveBindingsForSession({
      tenantId: tenantCtx.tenantId,
      sessionId,
      vaultIds: [], // the repo mount names its own credential (§25.2)
    });
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      placeholderName: PLACEHOLDER,
      category: "git_token",
      allowedHosts: ["github.com"],
      credentialRef: { tenantId: tenantCtx.tenantId, vaultId, credentialKey: "github-pat" },
    });
    // THE GATE: nothing the harness/provider port carries contains the PAT.
    expect(JSON.stringify(bindings)).not.toContain(PAT);
  });

  it("resolves the PAT host-side only — the guest surface stays placeholder-only", async () => {
    const store = createVaultSecretStore(pool, { crypto: CRYPTO });
    const resolver = createVaultSecretResolver(pool, { crypto: CRYPTO });
    const [binding] = await store.resolveBindingsForSession({
      tenantId: tenantCtx.tenantId,
      sessionId,
      vaultIds: [],
    });

    // Host-side (inside the provider) the real value IS available…
    const resolved = await resolver.resolve(binding.credentialRef, binding.category);
    expect(resolved.value).toBe(PAT);

    // …while everything that crosses into the guest carries the placeholder only.
    const guestSurface = JSON.stringify({
      clone: guestCloneExec({
        url: REPO_URL,
        guestPath: "/mnt/repos/r/",
        mode: "egress",
        tokenPlaceholder: binding.placeholderName,
      }),
      gitConfigRemote: placeholderCloneUrl(REPO_URL, binding.placeholderName),
      guestEnv: { [binding.placeholderName.slice(1)]: binding.placeholderName },
    });
    expect(guestSurface).not.toContain(PAT);
    expect(guestSurface).not.toContain("ghp_");
    expect(guestSurface).toContain(PLACEHOLDER);
  });

  it("fails closed when the referenced credential is archived", async () => {
    await query(
      pool,
      `UPDATE vault_credentials SET status = 'archived'
        WHERE tenant_id = $1 AND vault_id = $2 AND key = 'github-pat'`,
      [tenantCtx.tenantId, vaultId],
    );
    const store = createVaultSecretStore(pool, { crypto: CRYPTO });
    const bindings = await store.resolveBindingsForSession({
      tenantId: tenantCtx.tenantId,
      sessionId,
      vaultIds: [],
    });
    expect(bindings).toEqual([]);
    await query(
      pool,
      `UPDATE vault_credentials SET status = 'active'
        WHERE tenant_id = $1 AND vault_id = $2 AND key = 'github-pat'`,
      [tenantCtx.tenantId, vaultId],
    );
  });
});
