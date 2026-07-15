import type {
  SandboxHandle,
  SandboxMetrics,
  SandboxProvider,
  SandboxStatus,
  SecretBinding,
} from "@pi-managed/backend";

/**
 * In-memory fake `SandboxProvider` (spec §5.4, §10). Happy-path behavior plus hooks
 * for test scenarios (crash simulation, scripted exec output).
 *
 * Secret bindings are recorded but never materialized — the fake holds only the opaque
 * `SecretBinding` refs, preserving the §25.5 invariant (no raw secret values in memory).
 */
export class FakeSandboxProvider implements SandboxProvider {
  private handles = new Map<string, FakeSandbox>();
  /** Recorded secret bindings per handle id (refs only — never values, §25.5). */
  readonly registeredBindings = new Map<string, SecretBinding[]>();
  /** Call log for lifecycle assertions. */
  readonly calls: FakeSandboxCall[] = [];
  /** Default status for newly provisioned sandboxes. */
  private nextStatus: SandboxStatus = "running";
  /** Scripted exec results, keyed by handle id. Falls back to a zero-exit result. */
  private execResults = new Map<string, ExecScriptEntry[]>();
  /** Scripted metrics samples, keyed by sandbox name. Falls back to the baseline. */
  private scriptedMetrics = new Map<string, SandboxMetrics>();

  /** Force the next status returned by `status()` (e.g. "crashed" for recovery tests).
   *  Also updates all already-provisioned sandboxes so a status poll reflects the
   *  crash without a new provision. */
  setNextStatus(status: SandboxStatus): void {
    this.nextStatus = status;
    for (const sb of this.handles.values()) {
      sb.status = status;
    }
  }

  /** Script the sequence of exec results for a sandbox (by its name, set at provision). */
  scriptExec(name: string, results: ExecScriptEntry[]): void {
    this.execResults.set(name, [...results]);
  }

  async provision(spec: {
    name: string;
    image: string;
    cpus: number;
    memoryMiB: number;
    secretBindings?: SecretBinding[];
    labels: { tenant: string; session: string };
  }): Promise<SandboxHandle> {
    this.calls.push({ kind: "provision", name: spec.name });
    // id === name, mirroring the real MicrosandboxProvider (provider.ts) so a handle
    // reconstructed from the persisted name (DbSessionStore.get, R2.8) re-attaches to the
    // same VM. A distinct `sb_`-prefixed id would only exist in the fake and mask that.
    const id = spec.name;
    const handle: SandboxHandle = {
      id,
      name: spec.name,
      labels: spec.labels,
    };
    const sb: FakeSandbox = {
      handle,
      status: this.nextStatus,
      spec,
    };
    this.handles.set(id, sb);
    if (spec.secretBindings) {
      this.registeredBindings.set(id, [...spec.secretBindings]);
    }
    return handle;
  }

  async exec(
    handle: SandboxHandle,
    _opts: { cmd: string | string[] },
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    truncated?: boolean;
  }> {
    this.calls.push({ kind: "exec", name: handle.name });
    const sb = this.require(handle);
    const entry = this.execResults.get(sb.handle.name)?.shift();
    if (entry) {
      return {
        stdout: entry.stdout ?? "",
        stderr: entry.stderr ?? "",
        exitCode: entry.exitCode ?? 0,
        truncated: entry.truncated,
      };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  async *execStream(
    handle: SandboxHandle,
    _opts: { cmd: string | string[] },
  ): AsyncIterable<{ stream: "stdout" | "stderr"; data: string }> {
    this.calls.push({ kind: "execStream", name: handle.name });
    const sb = this.require(handle);
    const entry = this.execResults.get(sb.handle.name)?.shift();
    if (entry?.chunks) {
      yield* entry.chunks;
    }
  }

  async stop(handle: SandboxHandle): Promise<void> {
    this.calls.push({ kind: "stop", name: handle.name });
    this.require(handle).status = "stopped";
  }

  async start(handle: SandboxHandle): Promise<void> {
    this.calls.push({ kind: "start", name: handle.name });
    // Cold reboot: fs preserved, processes lost (§10.3) — reflected as running.
    this.require(handle).status = this.nextStatus;
  }

  async snapshot(handle: SandboxHandle): Promise<string> {
    this.calls.push({ kind: "snapshot", name: handle.name });
    this.require(handle);
    return `snap_${handle.id}`;
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    this.calls.push({ kind: "destroy", name: handle.name });
    const sb = this.handles.get(handle.id);
    if (sb) {
      sb.status = "draining";
    }
    this.handles.delete(handle.id);
    this.registeredBindings.delete(handle.id);
  }

  async reattachByLabels(labels: {
    tenant: string;
    session?: string;
  }): Promise<SandboxHandle[]> {
    this.calls.push({ kind: "reattachByLabels", name: labels.tenant });
    // Label-SUBSET match (matches the real provider's `Sandbox.listWith({ labels })`):
    // a tenant-only query returns every surviving VM for that tenant; adding `session`
    // narrows to the exact VM. (The old exact combined-key match returned nothing for a
    // tenant-only query, which broke boot-time re-attach — R2.9.)
    const out: SandboxHandle[] = [];
    for (const sb of this.handles.values()) {
      if (sb.handle.labels.tenant !== labels.tenant) continue;
      if (labels.session !== undefined && sb.handle.labels.session !== labels.session) {
        continue;
      }
      out.push(sb.handle);
    }
    return out;
  }

  async status(handle: SandboxHandle): Promise<SandboxStatus> {
    return this.require(handle).status;
  }

  /**
   * Point-in-time metrics (§26.4), mirroring the real provider's contract: `null` for a
   * sandbox that is not `running` (stopped / crashed / destroyed), a sample otherwise.
   *
   * The sample is deterministic — the scripted value from {@link scriptMetrics}, or the
   * {@link DEFAULT_FAKE_METRICS} baseline with `sampledAt` fixed. Nothing here reads a
   * real cgroup; tests assert plumbing (tenant scoping, 404-vs-200, wire shape), and the
   * `@kvm` suite is what proves the numbers are real.
   */
  async metrics(handle: SandboxHandle): Promise<SandboxMetrics | null> {
    this.calls.push({ kind: "metrics", name: handle.name });
    const sb = this.handles.get(handle.id);
    if (!sb || sb.status !== "running") return null;
    return this.scriptedMetrics.get(sb.handle.name) ?? { ...DEFAULT_FAKE_METRICS };
  }

  /** Script the metrics sample returned for a sandbox (by its name). */
  scriptMetrics(name: string, metrics: SandboxMetrics): void {
    this.scriptedMetrics.set(name, metrics);
  }

  async registerSecretBinding(
    handle: SandboxHandle,
    binding: SecretBinding,
  ): Promise<void> {
    // Records the opaque ref only — never the value (§25.5).
    const list = this.registeredBindings.get(handle.id) ?? [];
    list.push(binding);
    this.registeredBindings.set(handle.id, list);
  }

  /** Test helper: get a handle by name (provisioned sandboxes are addressable by name). */
  handleForName(name: string): SandboxHandle {
    for (const sb of this.handles.values()) {
      if (sb.handle.name === name) return sb.handle;
    }
    throw new Error(`no fake sandbox named ${name}`);
  }

  private require(handle: SandboxHandle): FakeSandbox {
    const sb = this.handles.get(handle.id);
    if (!sb) throw new Error(`unknown sandbox handle: ${handle.id}`);
    return sb;
  }
}

/**
 * The baseline sample {@link FakeSandboxProvider.metrics} returns for a running sandbox
 * unless {@link FakeSandboxProvider.scriptMetrics} overrides it. Plausible values for a
 * mostly-idle 512 MiB VM — fixed, so assertions are exact.
 */
export const DEFAULT_FAKE_METRICS: SandboxMetrics = {
  cpuPercent: 1.5,
  memoryBytes: 64 * 1024 * 1024,
  memoryLimitBytes: 512 * 1024 * 1024,
  diskReadBytes: 1024,
  diskWriteBytes: 2048,
  netRxBytes: 512,
  netTxBytes: 256,
  uptimeMs: 30_000,
  sampledAt: "2026-01-01T00:00:00.000Z",
};

/** A scripted exec result (fake) — either a full `ExecResult` or streaming chunks. */
export interface ExecScriptEntry {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  truncated?: boolean;
  /** If set, `execStream` yields these instead of returning a buffered result. */
  chunks?: { stream: "stdout" | "stderr"; data: string }[];
}

interface FakeSandbox {
  handle: SandboxHandle;
  status: SandboxStatus;
  spec: {
    name: string;
    image: string;
    cpus: number;
    memoryMiB: number;
    secretBindings?: SecretBinding[];
    labels: { tenant: string; session: string };
  };
}

export type FakeSandboxCall =
  | { kind: "provision"; name: string }
  | { kind: "exec"; name: string }
  | { kind: "execStream"; name: string }
  | { kind: "stop"; name: string }
  | { kind: "start"; name: string }
  | { kind: "snapshot"; name: string }
  | { kind: "destroy"; name: string }
  | { kind: "reattachByLabels"; name: string }
  | { kind: "metrics"; name: string };
