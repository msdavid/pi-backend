/**
 * Real microsandbox `SandboxProvider` (WP-1.3, §5.4, §10).
 *
 * Implements {@link SandboxProvider} (ports.ts) by wrapping the `microsandbox` npm SDK
 * (NAPI, v0.6.6 — pinned, §30 item 13). Provisions tenant-namespaced detached microVMs
 * with labels, volumes, env/secret bindings, and compiled network policies; execs over
 * the control channel; and drives stop/start (checkpoint/resume), snapshot, crash
 * detection (via `status`), and boot-time re-attach by labels.
 *
 * **§25.5 invariant (trust boundary):** this provider never accepts a raw secret value
 * through the port surface. {@link ProvisionSpec.secretBindings} and
 * {@link registerSecretBinding} carry only placeholder names + opaque
 * {@link SecretCredentialRef}s. The provider resolves each ref to its real value
 * **host-side** via the injected {@link SecretResolver} and hands the value to the msb
 * SDK's secret mechanism; the guest sees only the `$MSB_<VAR>` placeholder. The resolver
 * is the only path by which secret material enters this module. Callers MUST NOT log
 * `SecretBinding` contents; this implementation never logs them either.
 *
 * **§25.2 git repos (R6.8):** `spec.repos` are materialized here. `egress` repos are
 * cloned INSIDE the guest from `https://x-access-token:$MSB_GIT_TOKEN_<slug>@host/…` —
 * the placeholder is all the guest ever holds (in `.git/config` and in its env); the real
 * PAT lives in microsandbox's host-side secret store and is substituted at the egress
 * boundary, only toward the binding's `allowedHosts`. `staged` repos (the fallback for
 * git hosts that cannot be TLS-intercepted) are cloned HOST-side with the resolved token
 * and bind-mounted read-only — the guest gets a working copy and no credential, so push
 * is not supported on that path.
 *
 * **Runtime setup:** the `microsandbox` SDK requires a one-time runtime bootstrap
 * (`~/.microsandbox` kernel/init images) via `import('microsandbox').then(m => m.install())`,
 * a Linux host with `/dev/kvm`, and the platform native package
 * (`@superradcompany/microsandbox-linux-x64-gnu`) for the `msb` binary + `libkrunfw`.
 * `@kvm`-tagged tests gate on `kvmRuntimeAvailable()` (both `/dev/kvm` and `isInstalled()`).
 */

import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { Sandbox } from "microsandbox";
import type {
  ExecChunk,
  ExecOptions,
  ExecResult,
  ProvisionSpec,
  RepoCloneSpec,
  SandboxHandle,
  SandboxMetrics,
  SandboxProvider,
  SandboxStatus,
  SecretBinding,
  SecretCredentialRef,
  SecretCategory,
  VolumeMount,
} from "../../domain/ports.js";
import { placeholderCloneUrl } from "../../domain/environment/compile-spec.js";
import { compileNetworkPolicy } from "./network-policy.js";
import {
  recordSandboxRunning,
  SpanAttrs,
  SpanNames,
  withSpan,
} from "../telemetry/conventions.js";

const execFileAsync = promisify(execFile);

/**
 * Host-side resolver from an opaque {@link SecretCredentialRef} to the secret material
 * the msb SDK needs. **The only path by which a raw secret value enters this module.**
 *
 * - For `environment_variable` creds: returns the resolved `value` plus the egress
 *   `allowedHosts` the value may be substituted toward (§25.4). Egress substitution
 *   itself requires TLS interception (§30 item 14 — OPEN); the provider registers the
 *   binding + allowed hosts, and the actual substitution happens in the msb runtime at
 *   egress, not here.
 * - For `mcp_oauth` / `static_bearer`: the token is injected by the backend MCP proxy
 *   (§25.3), never by this provider; {@link registerSecretBinding} is a no-op for those
 *   categories (the binding ref is still recorded for accounting).
 */
export interface SecretResolver {
  resolve(
    ref: SecretCredentialRef,
    category: SecretCategory,
    mcpServerUrl?: string,
  ): Promise<{ value: string; allowedHosts: string[] }>;
}

/** Options for {@link MicrosandboxProvider}. */
export interface MicrosandboxProviderOptions {
  /** Host-side secret resolver (§25.5). Required to honor secret bindings. */
  secretResolver?: SecretResolver;
  /**
   * Host directory the managed volume keys (`tenants/<t>/…`) resolve against — where a
   * `staged` repo clone is materialized before it is bind-mounted (§25.2 fallback). It
   * MUST be the same root microsandbox resolves relative bind sources against (the msb
   * working directory). Defaults to `process.cwd()`.
   */
  repoStageRoot?: string;
}

/** Timeout for a repo clone, host-side or in-guest (seconds). Clones are slow; execs aren't. */
const REPO_CLONE_TIMEOUT_SECS = 600;

/**
 * The exec that clones an `egress` repo INSIDE the guest (§25.2).
 *
 * The clone URL's password is the `$MSB_GIT_TOKEN_<slug>` placeholder — the real token is
 * held host-side by microsandbox and substituted at the egress boundary (§25.4). The
 * placeholder is what git persists into `.git/config`, so `git remote -v` /
 * `cat .git/config` / `env` inside the guest reveal the placeholder and nothing else, and
 * subsequent `fetch`/`push` keep working through the same substitution.
 *
 * Exported for tests: the returned {@link ExecOptions} is the complete guest-visible
 * surface of the clone and must never contain secret material.
 */
export function guestCloneExec(repo: RepoCloneSpec): ExecOptions {
  const url = repo.tokenPlaceholder
    ? placeholderCloneUrl(repo.url, repo.tokenPlaceholder)
    : repo.url;
  return {
    cmd: ["git", "clone", "--", url, repo.guestPath],
    // Never prompt: a missing/denied credential must fail the provision, not hang.
    env: { GIT_TERMINAL_PROMPT: "0" },
    timeout: REPO_CLONE_TIMEOUT_SECS,
  };
}

/** Recorded secret binding refs per sandbox id — refs only, never values (§25.5). */
interface BindingRecord {
  placeholderName: string;
  category: SecretCategory;
  credentialRef: SecretCredentialRef;
  mcpServerUrl?: string;
}

/** Default per-exec timeout in seconds (docs/decisions.md item 5). */
const DEFAULT_EXEC_TIMEOUT_SECS = 120;

/**
 * `SandboxProvider` backed by the real microsandbox NAPI SDK.
 *
 * Sandboxes are addressed by their (tenant-namespaced) `name`, which is the SDK's stable
 * primary key. {@link SandboxHandle.id} is set to that name so provision / reattach
 * produce identical handles.
 */
export class MicrosandboxProvider implements SandboxProvider {
  private readonly secretResolver: SecretResolver | undefined;
  private readonly repoStageRoot: string;
  /** Recorded binding refs per sandbox id (refs only — §25.5). */
  private readonly bindings = new Map<string, BindingRecord[]>();

  constructor(opts: MicrosandboxProviderOptions = {}) {
    this.secretResolver = opts.secretResolver;
    this.repoStageRoot = opts.repoStageRoot ?? process.cwd();
  }

  // -- SandboxProvider (§10) -------------------------------------------------
  //
  // Every lifecycle op below is wrapped in its `pi.sandbox.*` span (WP-8.1) and moves
  // the `pi.sandbox.running` gauge. The wrappers are purely observational: each defers
  // to the unchanged `*Inner` body, and `withSpan` re-throws whatever that body threw,
  // so control flow and error handling are exactly what they were before.

  async provision(spec: ProvisionSpec): Promise<SandboxHandle> {
    return withSpan(SpanNames.SANDBOX_PROVISION, async (span) => {
      span.setAttribute(SpanAttrs.SANDBOX_ID, spec.name);
      const tenant = spec.labels?.tenant;
      const session = spec.labels?.session;
      if (tenant) span.setAttribute(SpanAttrs.TENANT_ID, tenant);
      if (session) span.setAttribute(SpanAttrs.SESSION_ID, session);
      const handle = await this.provisionInner(spec);
      recordSandboxRunning(1, { [SpanAttrs.SANDBOX_ID]: handle.id });
      return handle;
    });
  }

  private async provisionInner(spec: ProvisionSpec): Promise<SandboxHandle> {
    // §25.2 staged fallback: clone host-side BEFORE create so the read-only bind mount
    // compiled by `compileVolumeMounts` has something to bind. The token is used only in
    // this host process and never enters the guest.
    await this.stageRepos(spec);

    const builder = Sandbox.builder(spec.name)
      .cpus(spec.cpus)
      .memory(spec.memoryMiB)
      .labels(spec.labels)
      .detached(spec.detached)
      // Create-or-recreate semantics (§10.1 "create or re-create").
      .replace();

    // ROB-17: enforce the compiled disk budget. `diskMiB` sizes the OCI rootfs writable
    // overlay (`ImageBuilder.upperSize`), so an agent cannot fill unbounded host disk. When
    // no budget is set, keep the plain image resolution (the SDK's default overlay size).
    if (spec.diskMiB !== undefined) {
      builder.imageWith((i) => i.oci(spec.image).upperSize(spec.diskMiB!));
    } else {
      builder.image(spec.image);
    }

    for (const mount of spec.volumes ?? []) {
      applyVolume(builder, mount);
    }

    // Non-secret env vars only (§25.5). Credentials go through secretBindings.
    if (spec.env) {
      builder.envs(spec.env);
    }

    // Secret bindings: resolve refs host-side; guest sees only $MSB_ placeholders.
    let hasGitToken = false;
    for (const binding of spec.secretBindings ?? []) {
      if (
        binding.category === "environment_variable" ||
        binding.category === "git_token"
      ) {
        await this.applySecretBinding(builder, binding);
        if (binding.category === "git_token") hasGitToken = true;
      }
      // mcp_oauth / static_bearer: injected by the MCP proxy (§25.3) — not here.
    }

    // Network policy (compiled from the port contract). A git_token secret is only
    // substituted on an INTERCEPTED TLS connection (§12 constraint), and the guest's git
    // must accept the interception certificate — so trust the host CAs whenever a
    // git_token binding is present (§25.2). Without this, the intercepted clone fails the
    // guest's certificate check rather than leaking anything.
    builder.network((n) => {
      const withPolicy = n.policy(compileNetworkPolicy(spec.networkPolicy));
      return hasGitToken ? withPolicy.trustHostCAs(true) : withPolicy;
    });

    await builder.create();

    // §25.2: clone `egress` repos inside the guest, using the placeholder as the
    // credential. Runs after create() because it executes in the running VM.
    await this.cloneReposInGuest(spec);

    const handle: SandboxHandle = {
      id: spec.name,
      name: spec.name,
      labels: spec.labels,
    };
    // Record binding refs (not values) for accounting / destroy purge.
    if (spec.secretBindings) {
      this.bindings.set(
        handle.id,
        spec.secretBindings.map((b) => ({
          placeholderName: b.placeholderName,
          category: b.category,
          credentialRef: b.credentialRef,
          mcpServerUrl: b.mcpServerUrl,
        })),
      );
    }
    return handle;
  }

  async exec(handle: SandboxHandle, opts: ExecOptions): Promise<ExecResult> {
    return withSpan(SpanNames.SANDBOX_EXEC, async (span) => {
      span.setAttribute(SpanAttrs.SANDBOX_ID, handle.id);
      const sb = await this.connectRunning(handle.name);
      const out = await this.runExec(sb, opts);
      const result: ExecResult = {
        stdout: out.stdout(),
        stderr: out.stderr(),
        exitCode: out.code,
      };
      // A non-zero exit is a legitimate tool outcome, not a span error — record it as
      // an attribute so failing execs are queryable without polluting the error rate.
      span.setAttribute("pi.sandbox.exit_code", result.exitCode);
      return result;
    });
  }

  async *execStream(
    handle: SandboxHandle,
    opts: ExecOptions,
  ): AsyncIterable<ExecChunk> {
    const sb = await this.connectRunning(handle.name);
    const stream = await this.runExecStream(sb, opts);
    for await (const ev of stream) {
      if (ev.kind === "stdout" || ev.kind === "stderr") {
        yield {
          stream: ev.kind,
          data: Buffer.from(ev.data).toString("utf8"),
        };
      }
      // "started" / "exited" carry no streamable output; exit code surfaced via wait().
    }
  }

  /** Checkpoint + stop (§10.3) — the `pi.sandbox.checkpoint` boundary. */
  async stop(handle: SandboxHandle): Promise<void> {
    return withSpan(SpanNames.SANDBOX_CHECKPOINT, async (span) => {
      span.setAttribute(SpanAttrs.SANDBOX_ID, handle.id);
      const h = await Sandbox.get(handle.name);
      await h.stop();
      recordSandboxRunning(-1, { [SpanAttrs.SANDBOX_ID]: handle.id });
    });
  }

  async start(handle: SandboxHandle): Promise<void> {
    return withSpan(SpanNames.SANDBOX_START, async (span) => {
      span.setAttribute(SpanAttrs.SANDBOX_ID, handle.id);
      // Cold reboot from a stopped checkpoint: fs preserved, processes lost (§10.3).
      await Sandbox.startDetached(handle.name);
      recordSandboxRunning(1, { [SpanAttrs.SANDBOX_ID]: handle.id });
    });
  }

  async snapshot(handle: SandboxHandle): Promise<string> {
    return withSpan(SpanNames.SANDBOX_SNAPSHOT, async (span) => {
      span.setAttribute(SpanAttrs.SANDBOX_ID, handle.id);
      const h = await Sandbox.get(handle.name);
      // Sandbox must be stopped/crashed to snapshot (SDK requirement).
      const snap = await h.snapshot(`${handle.name}-snap-${Date.now()}`);
      // Prefer the digest (stable, content-addressed); fall back to the path.
      return snap.digest ?? snap.path;
    });
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    return withSpan(SpanNames.SANDBOX_DESTROY, async (span) => {
      span.setAttribute(SpanAttrs.SANDBOX_ID, handle.id);
      const h = await Sandbox.get(handle.name);
      const wasRunning = h.status === "running" || h.status === "draining";
      if (wasRunning) {
        await h.kill();
        await h.waitUntilStopped();
      }
      await h.remove();
      // Purge recorded binding refs (§12.1) — they were refs only, never values.
      this.bindings.delete(handle.id);
      // Only a VM that was still up leaves the running gauge; one already stopped was
      // decremented by `stop()`, so decrementing again would drive the gauge negative.
      if (wasRunning) {
        recordSandboxRunning(-1, { [SpanAttrs.SANDBOX_ID]: handle.id });
      }
    });
  }

  async reattachByLabels(labels: {
    tenant: string;
    session?: string;
  }): Promise<SandboxHandle[]> {
    const filter: Record<string, string> = { tenant: labels.tenant };
    if (labels.session !== undefined) filter.session = labels.session;
    const handles = await Sandbox.listWith({ labels: filter });
    const out: SandboxHandle[] = [];
    for (const h of handles) {
      const { tenant, session } = await readLabels(h);
      out.push({ id: h.name, name: h.name, labels: { tenant, session } });
    }
    return out;
  }

  async status(handle: SandboxHandle): Promise<SandboxStatus> {
    const h = await Sandbox.get(handle.name);
    // SDK SandboxStatus is exactly "running" | "stopped" | "crashed" | "draining".
    return h.status as SandboxStatus;
  }

  /**
   * Point-in-time per-VM metrics (§26.4), read straight from the msb SDK's
   * `SandboxHandle.metrics()` (`microsandbox@0.6.6`, `dist/metrics.d.ts`). No sidecar and
   * no Prometheus round-trip: this is a pull against the running VM.
   *
   * `null` (not a throw) when there is nothing to sample — the VM is stopped/crashed, or
   * the sandbox no longer exists (a stale handle on a session whose VM was destroyed).
   * The SDK reports uptime in ms and memory/IO in bytes; only the fields the port
   * publishes are mapped — the rest of the SDK's struct (host-resident memory, upper-layer
   * disk accounting) is deliberately not part of the wire contract.
   */
  async metrics(handle: SandboxHandle): Promise<SandboxMetrics | null> {
    let h: Awaited<ReturnType<typeof Sandbox.get>>;
    try {
      h = await Sandbox.get(handle.name);
    } catch {
      return null; // no such sandbox (destroyed / never provisioned on this host)
    }
    if (h.status !== "running") return null; // nothing to sample on a stopped/crashed VM
    const m = await h.metrics();
    return {
      cpuPercent: m.cpuPercent,
      memoryBytes: m.memoryBytes,
      memoryLimitBytes: m.memoryLimitBytes,
      diskReadBytes: m.diskReadBytes,
      diskWriteBytes: m.diskWriteBytes,
      netRxBytes: m.netRxBytes,
      netTxBytes: m.netTxBytes,
      uptimeMs: m.uptimeMs,
      sampledAt: m.timestamp.toISOString(),
    };
  }

  async registerSecretBinding(
    handle: SandboxHandle,
    binding: SecretBinding,
  ): Promise<void> {
    // Record the opaque ref (never the value) for accounting / destroy purge.
    const list = this.bindings.get(handle.id) ?? [];
    list.push({
      placeholderName: binding.placeholderName,
      category: binding.category,
      credentialRef: binding.credentialRef,
      mcpServerUrl: binding.mcpServerUrl,
    });
    this.bindings.set(handle.id, list);

    // environment_variable / git_token: register host-side so the guest sees the $MSB_
    // placeholder; the real value is resolved via the resolver and never exposed to the
    // guest (§25.5, §25.2).
    // mcp_oauth / static_bearer: the MCP proxy injects the token (§25.3) — no-op here.
    if (
      binding.category !== "environment_variable" &&
      binding.category !== "git_token"
    ) {
      return;
    }
    const { value, allowedHosts } = await this.resolveBinding(binding);
    const envVar = envVarFromPlaceholder(binding.placeholderName);
    const h = await Sandbox.get(handle.name);
    // Secrets take effect at boot (§25.4); restart applies them immediately.
    await h.modify({
      secrets: {
        [envVar]: {
          value,
          placeholder: binding.placeholderName,
          allowedHosts,
        },
      },
      policy: "restart",
    });
  }

  // -- internals -----------------------------------------------------------

  /** Connect to a running sandbox by name (for exec / execStream). */
  private async connectRunning(name: string): Promise<Sandbox> {
    const h = await Sandbox.get(name);
    return h.connect();
  }

  /** Register an environment_variable / git_token secret on the provision-time builder. */
  private async applySecretBinding(
    builder: ReturnType<typeof Sandbox.builder>,
    binding: SecretBinding,
  ): Promise<void> {
    const { value, allowedHosts } = await this.resolveBinding(binding);
    const envVar = envVarFromPlaceholder(binding.placeholderName);
    builder.secret((s) => {
      let b = s.env(envVar).value(value).placeholder(binding.placeholderName);
      for (const host of allowedHosts) b = b.allowHost(host);
      return b;
    });
  }

  /**
   * Resolve a binding host-side (§25.5) and compute the hosts its value may be
   * substituted toward.
   *
   * The allow-list is the union of the binding's own `allowedHosts` (a `git_token`
   * binding pins the repo's git host — §25.2) and any hosts the resolver derives from the
   * credential. A `git_token` with an EMPTY allow-list is rejected: microsandbox would
   * hold a secret that can be sent nowhere, so the clone would silently ship the
   * placeholder to the git host instead of failing — better to fail the provision loudly.
   */
  private async resolveBinding(
    binding: SecretBinding,
  ): Promise<{ value: string; allowedHosts: string[] }> {
    if (!this.secretResolver) {
      throw new Error(
        `MicrosandboxProvider: cannot register ${binding.category} secret binding ` +
          "without a SecretResolver (§25.5)",
      );
    }
    const resolved = await this.secretResolver.resolve(
      binding.credentialRef,
      binding.category,
      binding.mcpServerUrl,
    );
    const allowedHosts = [
      ...new Set([...(binding.allowedHosts ?? []), ...resolved.allowedHosts]),
    ];
    if (binding.category === "git_token" && allowedHosts.length === 0) {
      throw new Error(
        "MicrosandboxProvider: refusing git_token binding with no allowed host — the " +
          "token could never be substituted at egress (§25.2)",
      );
    }
    return { value: resolved.value, allowedHosts };
  }

  /**
   * Clone the spec's `egress` repos inside the guest (§25.2). The credential in the clone
   * URL is the `$MSB_` placeholder, so nothing secret is written into the guest
   * filesystem; microsandbox substitutes the real token at egress (§25.4).
   *
   * A failed clone fails the provision: a session whose repo is missing is not a session
   * the subscriber asked for.
   */
  private async cloneReposInGuest(spec: ProvisionSpec): Promise<void> {
    const egress = (spec.repos ?? []).filter((r) => r.mode === "egress");
    if (egress.length === 0) return;
    const sb = await this.connectRunning(spec.name);
    for (const repo of egress) {
      const out = await this.runExec(sb, guestCloneExec(repo));
      if (out.code !== 0) {
        throw new Error(
          `MicrosandboxProvider: git clone of ${repo.url} into ${repo.guestPath} failed ` +
            `(exit ${out.code}): ${out.stderr()}`,
        );
      }
    }
  }

  /**
   * Stage the spec's `staged` repos on the HOST (§25.2 fallback for git hosts that cannot
   * be TLS-intercepted — cert pinning / non-TLS transports, §12, §30 item 14).
   *
   * The PAT is resolved host-side and passed to git through a `credential.helper` that
   * reads it from the child's env — it never appears in argv (so not in the host's
   * process table) and never crosses into the guest. The clone is then bind-mounted
   * READ-ONLY (`compileVolumeMounts`), so the guest holds no credential and cannot push:
   * this path supports read-only working copies only.
   */
  private async stageRepos(spec: ProvisionSpec): Promise<void> {
    const staged = (spec.repos ?? []).filter((r) => r.mode === "staged");
    for (const repo of staged) {
      const source = repo.volumeSource;
      if (!source || source.startsWith("/") || source.split("/").includes("..")) {
        throw new Error(
          `MicrosandboxProvider: refusing staged repo with non-managed volume source ` +
            `${JSON.stringify(source)} (§25.1)`,
        );
      }
      const dest = path.join(this.repoStageRoot, source);
      if (await isGitRepo(dest)) continue; // already staged by an earlier provision
      let token: string | undefined;
      if (repo.credentialRef) {
        if (!this.secretResolver) {
          throw new Error(
            "MicrosandboxProvider: cannot stage an authenticated repo without a " +
              "SecretResolver (§25.5)",
          );
        }
        const resolved = await this.secretResolver.resolve(
          repo.credentialRef,
          "git_token",
        );
        token = resolved.value;
      }
      await mkdir(path.dirname(dest), { recursive: true });
      await hostClone(repo.url, dest, token);
    }
  }

  /** Run a buffered exec with options applied. */
  private async runExec(sb: Sandbox, opts: ExecOptions) {
    const { cmd, configure } = prepareExec(opts);
    return sb.execWith(cmd, configure);
  }

  /** Start a streaming exec with options applied. */
  private async runExecStream(sb: Sandbox, opts: ExecOptions) {
    const { cmd, configure } = prepareExec(opts);
    return sb.execStreamWith(cmd, configure);
  }
}

/**
 * Apply a {@link VolumeMount} to the builder as a bind mount.
 *
 * **§25.1 defense-in-depth:** `mount.source` is a backend-managed, tenant-scoped
 * object-store key (`tenants/<tenant>/…`) — never a caller-supplied host path (the
 * API contract + `compileVolumeMounts` guarantee this). This guard fails closed if a
 * source ever looks like an absolute host path or contains a `..` traversal, so a raw
 * host path can never reach the msb `.bind()` even if an upstream check regresses.
 */
function applyVolume(
  builder: ReturnType<typeof Sandbox.builder>,
  mount: VolumeMount,
): void {
  if (mount.source.startsWith("/") || mount.source.split("/").includes("..")) {
    throw new Error(
      `MicrosandboxProvider: refusing volume with non-managed source ${JSON.stringify(
        mount.source,
      )} — sources must be tenant-scoped object-store keys (§25.1)`,
    );
  }
  builder.volume(mount.guestPath, (m) => {
    let b = m.bind(mount.source);
    if (mount.readOnly) b = b.readonly();
    return b;
  });
}

/** True when `dir` is an existing git working copy (staged by an earlier provision). */
async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const st = await stat(path.join(dir, ".git"));
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

/**
 * Host-side `git clone` for the §25.2 staged fallback.
 *
 * The token (when present) is passed ONLY through the child's environment and read by an
 * inline `credential.helper` — never through argv, never into a config file, and never
 * into the guest. Errors are re-thrown with the token scrubbed from any git output.
 */
async function hostClone(url: string, dest: string, token?: string): Promise<void> {
  const args: string[] = ["clone"];
  if (token) {
    args.push(
      "-c",
      "credential.helper=!f() { echo username=x-access-token; echo \"password=$PI_GIT_TOKEN\"; }; f",
    );
  }
  args.push("--", url, dest);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    ...(token ? { PI_GIT_TOKEN: token } : {}),
  };
  try {
    await execFileAsync("git", args, {
      env,
      timeout: REPO_CLONE_TIMEOUT_SECS * 1000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const scrubbed = token ? msg.split(token).join("***") : msg;
    throw new Error(
      `MicrosandboxProvider: host-side clone of ${url} failed (§25.2 staged fallback): ${scrubbed}`,
    );
  }
}

/** Derive the guest env-var name from a `$MSB_<VAR>` placeholder (§12, §25.1). */
function envVarFromPlaceholder(placeholderName: string): string {
  return placeholderName.replace(/^\$/, "");
}

/** Configure an exec-options builder (cwd/env/timeout/rlimit) after setting args. */
interface ExecOptionsBuilder {
  args(args: string[]): unknown;
  cwd(cwd: string): unknown;
  envs(vars: Record<string, string>): unknown;
  timeout(ms: number): unknown;
  rlimit(resource: string, limit: number): unknown;
}

/** Resolve the exec target + args + a builder-configurator from {@link ExecOptions}. */
function prepareExec(opts: ExecOptions): {
  cmd: string;
  configure: <T extends ExecOptionsBuilder>(b: T) => T;
} {
  // A string cmd is run via the shell; an array is exec'd directly (ports.ts).
  const [cmd, ...args] = Array.isArray(opts.cmd)
    ? opts.cmd
    : ["sh", "-c", opts.cmd as string];
  const timeoutMs = (opts.timeout ?? DEFAULT_EXEC_TIMEOUT_SECS) * 1000;
  const { cwd, env } = opts;
  const nofile = opts.rlimit?.fileDescriptors;
  // SDK setters mutate in place and return `this`; we chain for side effects and
  // return the same builder so the SDK's polymorphic `this` is preserved.
  const configure = <T extends ExecOptionsBuilder>(b: T): T => {
    b.args(args);
    if (cwd) b.cwd(cwd);
    if (env) b.envs(env);
    b.timeout(timeoutMs);
    // fileDescriptors → nofile. memory/cpu are VM-level limits set at provision, not rlimit.
    if (nofile !== undefined) b.rlimit("nofile", nofile);
    return b;
  };
  return { cmd, configure };
}

/** Read the {tenant, session} labels from an SDK sandbox handle's config. */
async function readLabels(h: Awaited<ReturnType<typeof Sandbox.get>>): Promise<{
  tenant: string;
  session: string;
}> {
  try {
    const cfg = (await h.config()) as Record<string, unknown> & {
      labels?: Record<string, string>;
    };
    const labels = cfg?.labels ?? {};
    return { tenant: labels.tenant ?? "", session: labels.session ?? "" };
  } catch {
    return { tenant: "", session: "" };
  }
}
