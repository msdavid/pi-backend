/**
 * @pi-managed/contracts — Environment resource family.
 *
 * Mirrors docs/api-reference.md §"Environments". Defines the sandbox configuration
 * where sessions run. Not versioned (§6.2). Phase 1 rejects `self_hosted` (422).
 */

import { z } from "zod";
import { Name, Metadata, ResourceStatus, Timestamp } from "./common.js";
import { envId, fileId, memId } from "./ids.js";
import { vaultId } from "./ids.js";

export const EnvironmentType = z.enum(["cloud", "self_hosted"]);
export type EnvironmentType = z.infer<typeof EnvironmentType>;

/**
 * Per-VM resource maxima (ROB-17). Guardrails against a request that could never be
 * admitted (or that would oversubscribe a host): a single microVM may ask for at most
 * {@link MAX_VM_CPUS} cores, {@link MAX_VM_MEMORY_MIB} of memory, and
 * {@link MAX_VM_DISK_MIB} of writable disk. These are ceilings, not defaults — the
 * provisioner still applies its own smaller defaults when a field is omitted.
 */
export const MAX_VM_CPUS = 64;
export const MAX_VM_MEMORY_MIB = 262_144; // 256 GiB
export const MAX_VM_DISK_MIB = 1_048_576; // 1 TiB

export const EnvironmentResources = z.object({
  cpus: z.number().int().positive().max(MAX_VM_CPUS).optional(),
  memoryMiB: z.number().int().positive().max(MAX_VM_MEMORY_MIB).optional(),
  diskMiB: z.number().int().positive().max(MAX_VM_DISK_MIB).optional(),
});
export type EnvironmentResources = z.infer<typeof EnvironmentResources>;

/**
 * Networking mode (§6.2/§10.5). `unrestricted` compiles to microsandbox
 * `publicOnly()` (NOT `allowAll()`); `limited` is default-deny + explicit allows.
 */
export const Networking = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("unrestricted") }),
  z.object({ mode: z.literal("limited"), allowedHosts: z.array(z.string()) }),
]);
export type Networking = z.infer<typeof Networking>;

/**
 * Guest mount path (§25.1). A mount's `destination` is the path INSIDE the guest
 * where the resolved volume appears. It must live under the backend-managed `/mnt/`
 * root and may not traverse out of it: no `..` segment may reach a caller path to a
 * sensitive guest location, and the backend never lets it reach a host `.bind()`.
 */
export const GuestMountPath = z
  .string()
  .startsWith("/mnt/", "destination must be under /mnt/")
  .refine((p) => !p.split("/").includes(".."), {
    message: "destination must not contain '..' path segments",
  });
export type GuestMountPath = z.infer<typeof GuestMountPath>;

/**
 * Git access-token auth for a `repo` mount (§25.2 — **security-critical**).
 *
 * The mount NEVER carries a token: it carries a *reference* to a vault credential the
 * backend resolves host-side. The credential is an ordinary `environment_variable`
 * credential (§12.1) whose value is the PAT.
 *
 * At provision the backend registers the PAT as a microsandbox secret binding
 * (`git_token` category) and gives the guest ONLY the `$MSB_GIT_TOKEN_<slug>`
 * placeholder — in the clone URL, in `.git/config`, and in the guest env. The real
 * token is substituted at the egress boundary (§25.4). An agent that runs
 * `git remote -v` / `cat .git/config` / `env` sees the placeholder, never the token.
 */
export const GitTokenAuth = z.object({
  type: z.literal("git_token"),
  /** Vault holding the PAT credential. */
  vaultId: vaultId,
  /** Key of the `environment_variable` credential in that vault whose value is the PAT. */
  credentialKey: z.string().min(1),
});
export type GitTokenAuth = z.infer<typeof GitTokenAuth>;

/**
 * How a `repo` mount is materialized (§25.2).
 *
 * - `egress` (default when `auth` is present) — the repo is cloned **inside the guest**
 *   with the `$MSB_` placeholder as the credential; the real token is substituted at the
 *   egress proxy. Requires the git host to be TLS-interceptable. Clone/fetch/push all work.
 * - `staged` — FALLBACK for hosts that cannot be TLS-intercepted (cert pinning, non-TLS
 *   transports; §12, §30 item 14). The backend clones the repo **host-side** into the
 *   tenant's managed repo root and bind-mounts it **read-only**. The token never enters
 *   the guest at all — and neither does push support (the mount is read-only and carries
 *   no credential).
 */
export const RepoCloneMode = z.enum(["egress", "staged"]);
export type RepoCloneMode = z.infer<typeof RepoCloneMode>;

/**
 * Mount entry (§6.2, §25.1 — **security-critical**). A mount names a
 * BACKEND-MANAGED resource, never a caller-supplied host path: the backend resolves
 * each variant to a tenant-scoped object-store key (see `compileVolumeMounts`), so no
 * caller string ever reaches a host bind mount. There is deliberately no free-form
 * `source` field. Mounts default to **read-only**; read-write requires an explicit
 * `readOnly: false`.
 *
 * Variants:
 *  - `memory_store` — a memory store (`mem_…`) owned by the tenant.
 *  - `file` — an uploaded file (`file_…`) owned by the tenant.
 *  - `repo` — a git repo at `url`. With `clone: "egress"` (default) it is cloned inside
 *    the guest using a `$MSB_` token placeholder (§25.2); with `clone: "staged"` it is
 *    cloned host-side under the tenant's managed repo root and mounted read-only.
 */
export const Mount = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("memory_store"),
    id: memId,
    destination: GuestMountPath.optional(),
    readOnly: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("file"),
    id: fileId,
    destination: GuestMountPath.optional(),
    readOnly: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("repo"),
    url: z.string().url(),
    /** Vault reference for the clone token (§25.2). Public repos need no auth. */
    auth: GitTokenAuth.optional(),
    /** `egress` (default) or the `staged` read-only fallback (§25.2). */
    clone: RepoCloneMode.optional(),
    destination: GuestMountPath.optional(),
    readOnly: z.boolean().optional(),
  }),
]);
export type Mount = z.infer<typeof Mount>;

export const EnvironmentCreate = z.object({
  name: Name,
  type: EnvironmentType,
  image: z.string().optional(),
  resources: EnvironmentResources.optional(),
  networking: Networking.optional(),
  packages: z.array(z.string()).optional(),
  mounts: z.array(Mount).optional(),
  maxDuration: z.number().int().positive().optional(),
  idleTimeout: z.number().int().nonnegative().optional(),
  metadata: Metadata.optional(),
});
export type EnvironmentCreate = z.infer<typeof EnvironmentCreate>;

export const EnvironmentUpdate = EnvironmentCreate.partial();
export type EnvironmentUpdate = z.infer<typeof EnvironmentUpdate>;

export const Environment = z.object({
  id: envId,
  name: Name,
  type: EnvironmentType,
  image: z.string().optional(),
  resources: EnvironmentResources.optional(),
  networking: Networking.optional(),
  packages: z.array(z.string()).optional(),
  mounts: z.array(Mount).optional(),
  maxDuration: z.number().int().positive().optional(),
  idleTimeout: z.number().int().nonnegative().optional(),
  status: ResourceStatus,
  metadata: Metadata.optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Environment = z.infer<typeof Environment>;

// --- Self-hosted work queue (Phase 4 stub, §10.4) --------------------------

export const WorkStats = z.object({
  depth: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  oldestQueuedAt: Timestamp.nullable(),
  workersPolling: z.number().int().nonnegative(),
});
export type WorkStats = z.infer<typeof WorkStats>;

export const WorkStopRequest = z.object({
  force: z.boolean().optional(),
});
export type WorkStopRequest = z.infer<typeof WorkStopRequest>;
