/**
 * `compileProvisionSpec` (WP-1.2) — convert an Environment resource into the
 * {@link ProvisionSpec} the SandboxProvider provisions from (§5.4 `provision`,
 * §10.1, §27.2).
 *
 * **§6.2 / §10.5 network-policy mapping (authoritative):**
 * - `unrestricted` → `{ mode: "unrestricted" }` (microsandbox `publicOnly()`,
 *   NOT `allowAll()`). The spec carries the literal `unrestricted` mode so the
 *   provider applies `publicOnly()`; it never degrades to an allow-all.
 * - `limited` → `{ mode: "limited", allowedHosts }` (default-deny + explicit
 *   `allowHost()` per host).
 *
 * `secretBindings` are intentionally NOT populated here — the vault resolver
 * (SecretStore, WP-1.9/1.5) fills those from the session's `vaultIds` and from the
 * environment's repo mounts (`compileGitTokenBindings`, §25.2). This function only
 * assembles the non-secret provisioning spec (§25.5 invariant: the harness never sees
 * credential values).
 *
 * **§25.2 git repos (R6.8):** a `repo` mount compiles to a {@link RepoCloneSpec}, not to
 * a bind mount. In the default `egress` mode the provider clones INSIDE the guest from a
 * URL whose password is the `$MSB_GIT_TOKEN_<slug>` placeholder — the token itself never
 * exists in the guest filesystem or env, and is substituted at the egress boundary
 * (§25.4). The `staged` mode is the fallback for git hosts that cannot be TLS-intercepted:
 * the provider clones host-side into the tenant's managed repo root and the repo is bound
 * READ-ONLY (no push support).
 */

import type { Environment, Mount as MountType } from "@pi-managed/contracts";
import { Mount } from "@pi-managed/contracts";
import type {
  NetworkPolicy,
  ProvisionSpec,
  RepoCloneSpec,
  SecretBinding,
  VolumeMount,
} from "../ports.js";

/** Minimal session context needed to label/name a sandbox. */
export interface CompileSessionCtx {
  tenantId: string;
  sessionId: string;
}

/** The only part of an Environment the repo/git-token compilers need. */
export type EnvironmentMounts = Pick<Environment, "mounts">;

/** A `repo` mount that survived {@link Mount} re-validation. */
type RepoMount = Extract<MountType, { type: "repo" }>;

/**
 * The repo mounts of an environment, re-validated through the {@link Mount} contract
 * (the DB stores mounts as jsonb and does not re-parse on read — fail closed on rows
 * written before this hardening).
 */
function repoMounts(env: EnvironmentMounts): RepoMount[] {
  const out: RepoMount[] = [];
  for (const raw of env.mounts ?? []) {
    const parsed = Mount.safeParse(raw);
    if (!parsed.success) continue;
    if (parsed.data.type === "repo") out.push(parsed.data);
  }
  return out;
}

/** How a repo mount is materialized (§25.2). `egress` unless explicitly `staged`. */
function cloneMode(m: RepoMount): "egress" | "staged" {
  return m.clone ?? "egress";
}

/**
 * The git host a repo mount's token may be substituted toward (§25.2). This is the ONLY
 * host the PAT is ever released to: the provider registers it as the binding's
 * `allowHost()` rule, so an agent that exfiltrates the placeholder to any other host gets
 * the placeholder, not the token.
 */
export function gitHostOf(url: string): string {
  return new URL(url).host;
}

/** The guest-visible placeholder for a repo's token (§12, §25.1): `$MSB_GIT_TOKEN_<slug>`. */
export function gitTokenPlaceholder(url: string): string {
  return `$MSB_GIT_TOKEN_${repoSlug(url).replace(/-/g, "_").toUpperCase()}`;
}

/**
 * The clone URL the GUEST uses (§25.2). Carries the `$MSB_` placeholder as the basic-auth
 * password — never the token. This string is what lands in `.git/config`, so
 * `git remote -v` / `cat .git/config` inside the guest reveal the placeholder only; the
 * egress boundary substitutes the real value on the way out (§25.4).
 */
export function placeholderCloneUrl(url: string, placeholder: string): string {
  const u = new URL(url);
  u.username = "x-access-token";
  u.password = placeholder;
  return u.toString();
}

/**
 * Compile the `git_token` secret bindings for an environment's repo mounts (§25.2).
 *
 * Bindings are emitted ONLY for `egress` repos with an `auth` ref: a `staged` repo's
 * token is resolved host-side by the provider (it never enters the guest, so there is
 * nothing to bind), and a public repo needs no credential at all.
 *
 * **§25.5:** the binding carries the placeholder + an opaque credential ref — never a
 * value. `allowedHosts` pins the token to the repo's git host.
 */
export function compileGitTokenBindings(
  env: EnvironmentMounts,
  ctx: CompileSessionCtx,
): SecretBinding[] {
  const bindings: SecretBinding[] = [];
  for (const m of repoMounts(env)) {
    if (!m.auth || cloneMode(m) !== "egress") continue;
    bindings.push({
      placeholderName: gitTokenPlaceholder(m.url),
      category: "git_token",
      credentialRef: {
        tenantId: ctx.tenantId,
        vaultId: m.auth.vaultId,
        credentialKey: m.auth.credentialKey,
      },
      allowedHosts: [gitHostOf(m.url)],
    });
  }
  return bindings;
}

/**
 * Compile an environment's repo mounts → {@link RepoCloneSpec}s (§25.2).
 *
 * - `egress` (default): the provider clones inside the guest from
 *   {@link placeholderCloneUrl}; no volume is staged.
 * - `staged`: the provider clones host-side into the tenant-scoped managed repo key and
 *   the repo is bind-mounted READ-ONLY (see {@link compileVolumeMounts}) — the fallback
 *   for git hosts that cannot be TLS-intercepted (no push support).
 */
export function compileRepoClones(
  env: EnvironmentMounts,
  ctx: CompileSessionCtx,
): RepoCloneSpec[] {
  const clones: RepoCloneSpec[] = [];
  for (const m of repoMounts(env)) {
    const slug = repoSlug(m.url);
    const guestPath = m.destination ?? `/mnt/repos/${slug}/`;
    if (cloneMode(m) === "staged") {
      const spec: RepoCloneSpec = {
        url: m.url,
        guestPath,
        mode: "staged",
        volumeSource: `tenants/${ctx.tenantId}/repos/${slug}`,
      };
      if (m.auth) {
        spec.credentialRef = {
          tenantId: ctx.tenantId,
          vaultId: m.auth.vaultId,
          credentialKey: m.auth.credentialKey,
        };
      }
      clones.push(spec);
      continue;
    }
    const spec: RepoCloneSpec = { url: m.url, guestPath, mode: "egress" };
    if (m.auth) spec.tokenPlaceholder = gitTokenPlaceholder(m.url);
    clones.push(spec);
  }
  return clones;
}

/**
 * Map an Environment's networking config to a {@link NetworkPolicy}.
 *
 * `unrestricted` passes through as `{ mode: "unrestricted" }` — the provider
 * interprets this as `publicOnly()`, NOT `allowAll()`. `limited` carries the
 * explicit `allowedHosts` for default-deny + per-host allows.
 */
export function compileNetworkPolicy(env: Environment): NetworkPolicy {
  const net = env.networking;
  if (!net || net.mode === "unrestricted") {
    // Public internet allowed; private/loopback/cloud-metadata/host denied.
    // NOT allowAll() — the mode discriminator preserves this (§10.5).
    return { mode: "unrestricted" };
  }
  return { mode: "limited", allowedHosts: net.allowedHosts };
}

/**
 * Slug a repo URL into a filesystem-safe token for its tenant-scoped managed path.
 * Non-alphanumerics collapse to `-`; the result is never caller-controlled beyond
 * `[a-z0-9-]` and can never traverse (`..` cannot survive the replace).
 */
function repoSlug(url: string): string {
  return url
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Map an Environment's mounts to {@link VolumeMount} entries (§6.2, §25.1 —
 * **security-critical**).
 *
 * A mount's `source` is NEVER caller-supplied: each {@link Mount} variant is resolved
 * here to a backend-managed object-store key under the TENANT-SCOPED root
 * `tenants/<tenantId>/…`, so no caller string can ever reach the provider's host
 * `.bind()`. Mounts default to **read-only**; read-write requires an explicit
 * `readOnly: false`.
 *
 * Each stored mount is re-validated through the {@link Mount} contract before use:
 * the DB persists mounts as jsonb and does NOT re-parse on read, so a row written
 * before this hardening (or by any path that bypassed the API schema) is failed
 * closed here rather than trusted.
 */
export function compileVolumeMounts(
  env: Environment,
  ctx: CompileSessionCtx,
): VolumeMount[] {
  if (!env.mounts || env.mounts.length === 0) return [];
  const mounts: VolumeMount[] = [];
  const tenantRoot = `tenants/${ctx.tenantId}`;
  for (const raw of env.mounts) {
    const parsed = Mount.safeParse(raw);
    if (!parsed.success) continue; // fail closed on unvalidated/legacy rows
    const m = parsed.data;
    const readOnly = m.readOnly ?? true; // default read-only; RW must be explicit
    let source: string;
    let defaultGuest: string;
    switch (m.type) {
      case "memory_store":
        source = `${tenantRoot}/memory/${m.id}`;
        defaultGuest = `/mnt/memory/${m.id}/`;
        break;
      case "file":
        source = `${tenantRoot}/files/${m.id}`;
        defaultGuest = `/mnt/files/${m.id}/`;
        break;
      case "repo": {
        // §25.2: an `egress` repo is cloned INSIDE the guest (with the $MSB_ placeholder
        // as its credential) — there is nothing to bind. Only the `staged` fallback is a
        // volume, and it is ALWAYS read-only: the host-side clone carries no credential
        // into the guest, so push is not supported and a writable mount would only invite
        // work the agent cannot publish.
        if (cloneMode(m) !== "staged") continue;
        const slug = repoSlug(m.url);
        mounts.push({
          guestPath: m.destination ?? `/mnt/repos/${slug}/`,
          source: `${tenantRoot}/repos/${slug}`,
          readOnly: true,
        });
        continue;
      }
    }
    mounts.push({
      guestPath: m.destination ?? defaultGuest,
      source,
      readOnly,
    });
  }
  return mounts;
}

/**
 * Merge extra {@link VolumeMount}s into a compiled spec's volumes (R6.5a).
 *
 * The memory subsystem owns the authoritative mount for a memory store: it derives the
 * guest path from the store's *title* slug and the read-only flag from the store's
 * `access` column (`mountMemoryStores`), neither of which the environment row knows. So
 * an `extra` mount REPLACES any compiled mount that stages the same `source` (the
 * store's object-store prefix) — otherwise the same store would be staged twice, at two
 * paths, with two different read-only flags. A same-`guestPath` collision is likewise
 * resolved in favor of `extra`.
 */
export function mergeVolumeMounts(
  base: VolumeMount[] | undefined,
  extra: VolumeMount[],
): VolumeMount[] {
  if (extra.length === 0) return base ?? [];
  const sources = new Set(extra.map((m) => m.source));
  const guestPaths = new Set(extra.map((m) => m.guestPath));
  const kept = (base ?? []).filter(
    (m) => !sources.has(m.source) && !guestPaths.has(m.guestPath),
  );
  return [...kept, ...extra];
}

/**
 * Sanitize an id into a microsandbox-name-safe token: lowercase, non-alphanumerics
 * → `-`, collapsed. microsandbox sandbox names are `[a-z0-9-]+` (§10.1).
 */
function nameSafe(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Compile a {@link ProvisionSpec} from an Environment + session context.
 *
 * - `name`: tenant-namespaced sandbox name `t<tenant>-s<session>` (§10.1, §27.2).
 * - `image`/`cpus`/`memoryMiB`/`diskMiB`: from `env.resources`/`env.image`, with
 *   sane defaults where the environment omits them (provider requires cpus +
 *   memoryMiB as positive numbers).
 * - `volumes`: {@link compileVolumeMounts}.
 * - `networkPolicy`: {@link compileNetworkPolicy} (unrestricted≠allowAll).
 * - `labels`: `{ tenant, session }` (§27.2) — used for label-based re-attach.
 * - `detached: true`: the VM survives backend restarts (§4.2, §10.1).
 * - `secretBindings`: **omitted** — resolved by the SecretStore (WP-1.9/1.5).
 * - `env`: **omitted** — only non-secret literals belong here; none in Phase 1.
 */
export function compileProvisionSpec(
  env: Environment,
  ctx: CompileSessionCtx,
): ProvisionSpec {
  const resources = env.resources ?? {};
  const cpus = resources.cpus ?? 1;
  const memoryMiB = resources.memoryMiB ?? 512;
  const spec: ProvisionSpec = {
    name: `t${nameSafe(ctx.tenantId)}-s${nameSafe(ctx.sessionId)}`,
    image: env.image ?? "ubuntu:22.04",
    cpus,
    memoryMiB,
    networkPolicy: compileNetworkPolicy(env),
    labels: { tenant: ctx.tenantId, session: ctx.sessionId },
    detached: true,
  };
  if (resources.diskMiB !== undefined) {
    spec.diskMiB = resources.diskMiB;
  }
  const volumes = compileVolumeMounts(env, ctx);
  if (volumes.length > 0) {
    spec.volumes = volumes;
  }
  // Repo clones (§25.2). Carries the $MSB_ placeholder / an opaque credential ref — never
  // a token. The git_token BINDINGS are resolved by the SecretStore (secret-store.ts),
  // which is the single place session secret bindings are assembled (the session manager
  // overwrites `spec.secretBindings` with the store's result at first wake).
  const repos = compileRepoClones(env, ctx);
  if (repos.length > 0) {
    spec.repos = repos;
  }
  return spec;
}
