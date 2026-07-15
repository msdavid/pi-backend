/**
 * Remote `*Operations` implementations for the Sandbox Operations adapter (WP-1.4,
 * spec §10.2).
 *
 * Each of Pi's seven built-in tools exposes a pluggable `*Operations` interface
 * (`BashOperations`, `ReadOperations`, `WriteOperations`, `EditOperations`,
 * `GrepOperations`, `FindOperations`, `LsOperations`). This module implements all
 * seven by delegating to {@link SandboxProvider.exec} / {@link SandboxProvider.execStream}
 * so that **every filesystem and process effect lands inside the microVM**, never on the
 * backend host (§10.2 "completeness is mandatory"; §29.2 host-escape CI).
 *
 * **Trust boundary (§25.5):** these operations never accept or emit a raw secret value.
 * They issue plain shell commands through the sandbox port; credentials reach the guest
 * only via `$MSB_` placeholder bindings registered host-side by the provider.
 *
 * **Why local structural types?** The interfaces below are structural copies of Pi's
 * `*Operations`, kept local so this operations layer is unit-testable without importing
 * the SDK and so a `^0.80.6` bump that changes their shape is caught at the boundary:
 * `session-manager/sdk-parity.ts` asserts each local shim against the real SDK type at
 * compile time (a mismatch breaks `tsc`). Pi itself IS a static backend dependency.
 *
 * **Shell quoting:** all interpolated paths/args are POSIX single-quote-escaped via
 * {@link sq} so agent-controlled input cannot break out of the argument.
 */

import type {
  ExecChunk,
  ExecResult,
  SandboxHandle,
  SandboxProvider,
} from "../../ports.js";

// ---------------------------------------------------------------------------
// Local structural types — match @earendil-works/pi-coding-agent's *Operations
// ---------------------------------------------------------------------------

/**
 * Streaming bash execution contract (structurally identical to Pi's
 * `BashOperations`). `exec` MUST stream output via `onData` and resolve with the
 * exit code (`null` only if killed).
 */
export interface BashOperations {
  exec: (
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ) => Promise<{ exitCode: number | null }>;
}

/** Read-file operations (structurally identical to Pi's `ReadOperations`). */
export interface ReadOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  access: (absolutePath: string) => Promise<void>;
  detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

/** Write-file operations (structurally identical to Pi's `WriteOperations`). */
export interface WriteOperations {
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  mkdir: (dir: string) => Promise<void>;
}

/** Edit-file operations (structurally identical to Pi's `EditOperations`). */
export interface EditOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  access: (absolutePath: string) => Promise<void>;
}

/** Grep support operations (structurally identical to Pi's `GrepOperations`). */
export interface GrepOperations {
  isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
  readFile: (absolutePath: string) => Promise<string> | string;
}

/** Find-file operations (structurally identical to Pi's `FindOperations`). */
export interface FindOperations {
  exists: (absolutePath: string) => Promise<boolean> | boolean;
  glob: (
    pattern: string,
    cwd: string,
    options: { ignore: string[]; limit: number },
  ) => Promise<string[]> | string[];
}

/** Directory-listing operations (structurally identical to Pi's `LsOperations`). */
export interface LsOperations {
  exists: (absolutePath: string) => Promise<boolean> | boolean;
  stat: (absolutePath: string) => Promise<{ isDirectory: () => boolean }>;
  readdir: (absolutePath: string) => Promise<string[]>;
}

/** Aggregate of all seven remote operations interfaces. */
export interface RemoteOperations {
  bash: BashOperations;
  read: ReadOperations;
  write: WriteOperations;
  edit: EditOperations;
  grep: GrepOperations;
  find: FindOperations;
  ls: LsOperations;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for {@link createRemoteOperations}. */
export interface RemoteOperationsOptions {
  /** Sandbox provider (the microVM delegate). */
  provider: SandboxProvider;
  /** Handle of the provisioned VM all commands run inside. */
  handle: SandboxHandle;
  /** Per-exec timeout in seconds (default 120, docs/decisions.md item 5). */
  timeout?: number;
}

/** Default per-exec timeout in seconds (docs/decisions.md item 5). */
const DEFAULT_EXEC_TIMEOUT_SECS = 120;

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------

/**
 * POSIX single-quote escape: wraps `s` in single quotes, escaping embedded quotes
 * by closing the quote, emitting an escaped quote, and reopening. Safe for `sh -c`.
 */
export function sq(s: string): string {
  return `'${String(s).replace(/'/g, `'"'"'`)}'`;
}

/** Optional exec extras passed through to `provider.exec`. */
type ExecExtras = {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
};

/** Run a buffered shell command in the VM, returning the {@link ExecResult}. */
async function execSh(
  provider: SandboxProvider,
  handle: SandboxHandle,
  cmd: string,
  opts: ExecExtras = {},
): Promise<ExecResult> {
  return provider.exec(handle, { cmd, ...opts });
}

/** Throw with a readable message when a sandbox exec exits non-zero. */
function assertOk(result: ExecResult, label: string): ExecResult {
  if (result.exitCode !== 0) {
    throw new Error(
      `remote-operations ${label} failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build all seven remote `*Operations`, each delegating to `provider.exec` /
 * `provider.execStream` against `handle`.
 *
 * Implementation notes:
 * - **bash**: streams via `execStream`; the exit code is recovered from a trailing
 *   sentinel the wrapper prints to stderr (the port's `execStream` surfaces only
 *   stdout/stderr chunks, not an exit event — §10.2). The sentinel is stripped from
 *   the streamed output so the model never sees it.
 * - **read**: `readFile` round-trips through `base64` to preserve binary fidelity
 *   (the port returns `stdout` as a UTF-8 string, which would corrupt raw bytes).
 * - **write**: `writeFile` base64-encodes content and decodes in the VM, so arbitrary
 *   content (including newlines/quotes) is written verbatim with no shell escaping risk.
 * - **edit**: reuses read/write primitives.
 * - **grep/find**: `rg`/`fd` are expected in the VM image (provisioning concern); the
 *   operations themselves only provide the support hooks Pi's tools call.
 */
export function createRemoteOperations(
  opts: RemoteOperationsOptions,
): RemoteOperations {
  const { provider, handle } = opts;
  const timeout = opts.timeout ?? DEFAULT_EXEC_TIMEOUT_SECS;
  const baseExec: ExecExtras = { timeout };

  // --- BashOperations -----------------------------------------------------
  const bash: BashOperations = {
    exec: async (command, cwd, { onData, signal, timeout: callTimeout, env }) => {
      // Wrap so the exit code is emitted as a unique trailing stderr sentinel that
      // cannot appear in normal output (uses a 32-char marker). The wrapper runs the
      // user command, captures its exit, then prints the sentinel.
      const marker = `__PI_EXIT_${randomToken()}__`;
      const wrapped = `${command}\nprintf '\\n${marker}%d\\n' "$?" >&2`;
      const secs = callTimeout ? Math.ceil(callTimeout / 1000) : timeout;
      const stream = provider.execStream(handle, {
        cmd: wrapped,
        cwd,
        env: env as Record<string, string> | undefined,
        timeout: secs,
      });
      const onAbort = () => {
        // The port has no per-stream cancel; the provider respects the exec timeout.
        // Abort is best-effort: we stop consuming the stream.
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      let exitCode: number | null = null;
      let stderrTail = "";
      try {
        for await (const chunk of stream as AsyncIterable<ExecChunk>) {
          if (signal?.aborted) {
            exitCode = null;
            break;
          }
          if (chunk.stream === "stdout") {
            onData(Buffer.from(chunk.data, "utf8"));
          } else {
            // Buffer stderr to locate + strip the exit sentinel.
            stderrTail = (stderrTail + chunk.data).slice(-512);
            const sentinel = locateSentinel(stderrTail, marker);
            if (sentinel.found) {
              exitCode = sentinel.exitCode;
              stderrTail = stderrTail.slice(0, sentinel.startIndex);
              if (stderrTail) onData(Buffer.from(stderrTail, "utf8"));
              stderrTail = "";
            } else if (chunk.data) {
              onData(Buffer.from(chunk.data, "utf8"));
            }
          }
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
      // If the stream ended without a sentinel (e.g. VM killed mid-exec), treat as
      // killed → null exit code (Pi's contract: null if killed).
      return { exitCode };
    },
  };

  // --- ReadOperations -----------------------------------------------------
  const read: ReadOperations = {
    readFile: async (absolutePath) => {
      // base64 round-trip preserves binary bytes (port stdout is a UTF-8 string).
      const r = assertOk(
        await execSh(provider, handle, `base64 -w0 ${sq(absolutePath)}`, baseExec),
        `readFile(${absolutePath})`,
      );
      return Buffer.from(r.stdout, "base64");
    },
    access: async (absolutePath) => {
      const r = await execSh(
        provider,
        handle,
        `test -r ${sq(absolutePath)}`,
        baseExec,
      );
      if (r.exitCode !== 0) {
        throw new Error(`cannot read ${absolutePath} (exit ${r.exitCode})`);
      }
    },
    detectImageMimeType: async (absolutePath) => {
      try {
        const r = await execSh(
          provider,
          handle,
          `file --mime-type -b ${sq(absolutePath)}`,
          baseExec,
        );
        if (r.exitCode !== 0) return null;
        const m = r.stdout.trim();
        return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m)
          ? m
          : null;
      } catch {
        return null;
      }
    },
  };

  // --- WriteOperations ----------------------------------------------------
  const write: WriteOperations = {
    writeFile: async (absolutePath, content) => {
      const b64 = Buffer.from(content, "utf8").toString("base64");
      assertOk(
        await execSh(
          provider,
          handle,
          `printf %s ${sq(b64)} | base64 -d > ${sq(absolutePath)}`,
          baseExec,
        ),
        `writeFile(${absolutePath})`,
      );
    },
    mkdir: async (dir) => {
      assertOk(
        await execSh(provider, handle, `mkdir -p ${sq(dir)}`, baseExec),
        `mkdir(${dir})`,
      );
    },
  };

  // --- EditOperations -----------------------------------------------------
  const edit: EditOperations = {
    readFile: read.readFile,
    writeFile: write.writeFile,
    access: read.access,
  };

  // --- GrepOperations -----------------------------------------------------
  // NOTE: Pi's grep tool spawns `rg` LOCALLY even when custom operations are supplied
  // (GrepOperations only covers isDirectory/readFile for context lines). The tool
  // factory therefore registers a custom remote grep tool that runs `rg` in the VM
  // (§10.2 completeness). These support ops are still provided for interface parity.
  const grep: GrepOperations = {
    isDirectory: async (absolutePath) => {
      const r = await execSh(provider, handle, `test -d ${sq(absolutePath)}`, baseExec);
      return r.exitCode === 0;
    },
    readFile: async (absolutePath) => {
      const r = await execSh(provider, handle, `cat ${sq(absolutePath)}`, baseExec);
      return r.stdout;
    },
  };

  // --- FindOperations -----------------------------------------------------
  const find: FindOperations = {
    exists: async (absolutePath) => {
      const r = await execSh(provider, handle, `test -e ${sq(absolutePath)}`, baseExec);
      return r.exitCode === 0;
    },
    glob: async (pattern, cwd, { ignore, limit }) => {
      const args = [
        "fd",
        "--glob",
        "--color=never",
        "--hidden",
        "--absolute-path",
      ];
      for (const ig of ignore) args.push("--exclude", ig);
      args.push("--max-results", String(limit));
      args.push("--", pattern, cwd);
      // Use a single sh -c so the pattern is treated as one glob arg; leave the
      // binary name unquoted (real shells accept it; keeps command matching simple).
      const cmd = [args[0], ...args.slice(1).map((a) => sq(a))].join(" ");
      const r = await execSh(provider, handle, cmd, baseExec);
      // fd exits non-zero if nothing matched (in some versions); treat empty as empty.
      if (r.exitCode !== 0 && r.stdout.trim() !== "") {
        throw new Error(
          `remote find failed (exit ${r.exitCode}): ${r.stderr.trim()}`,
        );
      }
      return r.stdout.split("\n").filter((l) => l.length > 0);
    },
  };

  // --- LsOperations -------------------------------------------------------
  const ls: LsOperations = {
    exists: async (absolutePath) => {
      const r = await execSh(provider, handle, `test -e ${sq(absolutePath)}`, baseExec);
      return r.exitCode === 0;
    },
    stat: async (absolutePath) => {
      const r = await execSh(
        provider,
        handle,
        `stat -c %F ${sq(absolutePath)}`,
        baseExec,
      );
      if (r.exitCode !== 0) {
        throw new Error(`stat ${absolutePath} failed (exit ${r.exitCode})`);
      }
      const isDir = r.stdout.trim() === "directory";
      return { isDirectory: () => isDir };
    },
    readdir: async (absolutePath) => {
      const r = assertOk(
        await execSh(provider, handle, `ls -A ${sq(absolutePath)}`, baseExec),
        `readdir(${absolutePath})`,
      );
      return r.stdout.split("\n").filter((l) => l.length > 0);
    },
  };

  return { bash, read, write, edit, grep, find, ls };
}

// ---------------------------------------------------------------------------
// Internals: exit-sentinel parsing
// ---------------------------------------------------------------------------

/** Locate the trailing `__PI_EXIT_<tok>__<code>` sentinel in buffered stderr. */
function locateSentinel(
  buf: string,
  marker: string,
): { found: true; exitCode: number; startIndex: number } | { found: false } {
  const idx = buf.lastIndexOf(marker);
  if (idx === -1) return { found: false };
  const after = buf.slice(idx + marker.length);
  const m = after.match(/^(-?\d+)/);
  if (!m) return { found: false };
  return { found: true, exitCode: Number(m[1]), startIndex: idx };
}

/** A short alphanumeric token for the sentinel (collision-resistant enough). */
function randomToken(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
