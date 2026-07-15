/**
 * Session tool factory (WP-1.4, spec §10.2 / §11.3).
 *
 * Constructs the seven Pi built-in tools (`bash`, `read`, `write`, `edit`, `grep`,
 * `find`, `ls`) bound to **remote operations** that delegate to
 * {@link SandboxProvider.exec}, plus the backend-hosted `web_fetch` / `web_search`
 * tools (§11.1). Every file/process effect lands inside the microVM, never on the
 * backend host.
 *
 * **Construction-time completeness guard (§10.2 / §29.2):** each Pi tool factory is
 * invoked through {@link assertRemoteOperations}, which throws if a tool would be left
 * on Pi's default (host-executing) operations. A default-ops tool executes on the
 * backend host — a sandbox escape — so completeness is mandatory, not optional.
 *
 * **`grep` deviation (reported contradiction):** Pi's `GrepOperations` interface only
 * covers `isDirectory` / `readFile` (context-line support); the SDK's `createGrepTool`
 * still spawns `rg` **on the host** even when custom operations are supplied. That is a
 * host-execution path and violates the §10.2 invariant. The factory therefore
 * substitutes a **custom remote grep tool** ({@link createRemoteGrepTool}) that runs
 * `rg` inside the VM via `provider.exec`. The other six tools use Pi's factories with
 * remote operations (verified to fully delegate through `*Operations`).
 *
 * **`user_bash` disabled:** `user_bash` runs an interactive shell on the host; the
 * factory exports {@link disableUserBash} so the session manager can register a
 * `user_bash` handler that refuses host execution.
 *
 * Pi (`@earendil-works/pi-coding-agent`) is a static dependency of the backend (imported
 * directly by `materialize.ts` and `sandbox-toolset.ts`). The `createXTool` factories are
 * nonetheless **injected** into this module so the operations layer stays SDK-agnostic and
 * unit-testable with fakes; the real factories (`defaultRemoteToolFactories`) are supplied
 * by the session manager at wake.
 */

import { randomUUID } from "node:crypto";
import type { SandboxHandle, SandboxProvider } from "../../ports.js";
import { sq } from "./remote-operations.js";
import {
  createRemoteOperations,
  type BashOperations,
  type EditOperations,
  type FindOperations,
  type LsOperations,
  type ReadOperations,
  type WriteOperations,
} from "./remote-operations.js";
import { maybeSpillLargeOutput } from "./large-output.js";
import {
  createWebTools,
  type BackendTool,
  type ToolResult,
  type WebToolsOptions,
} from "./web-tools.js";

// ---------------------------------------------------------------------------
// Injected Pi tool factories
// ---------------------------------------------------------------------------

/**
 * Pi's `createXTool(cwd, { operations })` factories, injected by the session manager.
 * Each returns a Pi `AgentTool` (typed `unknown` here — the backend has no static dep
 * on the agent package; the session manager knows the real type).
 */
export interface RemoteToolFactories {
  createBashTool: (cwd: string, opts: { operations: BashOperations }) => unknown;
  createReadTool: (cwd: string, opts: { operations: ReadOperations }) => unknown;
  createWriteTool: (cwd: string, opts: { operations: WriteOperations }) => unknown;
  createEditTool: (cwd: string, opts: { operations: EditOperations }) => unknown;
  createFindTool: (cwd: string, opts: { operations: FindOperations }) => unknown;
  createLsTool: (cwd: string, opts: { operations: LsOperations }) => unknown;
}

/** A Pi-compatible tool object (minimal seam shape). */
export type Tool = BackendTool;

// ---------------------------------------------------------------------------
// Construction-time guard
// ---------------------------------------------------------------------------

/**
 * Assert that a remote `Operations` object was supplied to a tool factory. Throws if
 * `ops` is `undefined` — a default-ops tool executes on the backend host (sandbox
 * escape, §10.2). Called for every one of the six Pi-backed tools at construction.
 */
export function assertRemoteOperations<T>(
  toolName: string,
  ops: T | undefined,
): T {
  if (ops === undefined || ops === null) {
    throw new Error(
      `createRemoteTools: tool "${toolName}" was constructed without remote ` +
        `operations — a default-ops tool executes on the backend host (§10.2 ` +
        `sandbox-escape). completeness is mandatory.`,
    );
  }
  return ops;
}

// ---------------------------------------------------------------------------
// Custom remote grep tool (runs rg in the VM — see module docstring)
// ---------------------------------------------------------------------------

/** Parameters for the remote grep tool (matches Pi's `grep` schema). */
export interface RemoteGrepParams {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}

/** Options for {@link createRemoteGrepTool}. */
export interface RemoteGrepToolOptions {
  provider: SandboxProvider;
  handle: SandboxHandle;
  cwd: string;
  timeout?: number;
}

/** Build the custom remote `grep` tool that runs `rg` inside the VM. */
export function createRemoteGrepTool(
  opts: RemoteGrepToolOptions,
): Tool {
  const { provider, handle, cwd } = opts;
  const timeout = opts.timeout;
  const tool: Tool = {
    name: "grep",
    description:
      "Search file contents for a pattern (regex or literal). Respects .gitignore. " +
      "Runs ripgrep inside the sandbox VM; output is spilled to a sandbox file if large.",
    execute: async (params) => {
      const p = params as unknown as RemoteGrepParams;
      const pattern = String(p.pattern ?? "");
      if (!pattern) return textResult("grep requires a `pattern` parameter.");
      const searchPath = p.path ? String(p.path) : cwd;
      const limit = Math.max(1, p.limit ?? 100);
      const args = [
        "rg",
        "--line-number",
        "--color=never",
        "--hidden",
        `--max-count=${limit}`,
      ];
      if (p.ignoreCase) args.push("--ignore-case");
      if (p.literal) args.push("--fixed-strings");
      if (p.glob) args.push("--glob", String(p.glob));
      if (p.context && p.context > 0) args.push("-C", String(p.context));
      args.push("--", pattern, searchPath);
      const cmd = [args[0], ...args.slice(1).map((a) => sq(a))].join(" ");
      const r = await provider.exec(handle, { cmd, timeout, cwd: undefined });
      // rg exit 0 = matches, 1 = no matches, 2+ = error.
      if (r.exitCode !== 0 && r.exitCode !== 1) {
        return textResult(
          `grep failed (exit ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`,
        );
      }
      const output = r.stdout;
      const spill = await maybeSpillLargeOutput(output, { provider, handle });
      return textResult(spill.text);
    },
  };
  return tool;
}

// ---------------------------------------------------------------------------
// user_bash disabling
// ---------------------------------------------------------------------------

/**
 * A `user_bash` event handler that refuses host execution. The session manager
 * registers this on the `user_bash` event so Pi never spawns a local shell for `!`
 * commands (§10.2 — the only host-executing path in Pi's default toolset).
 */
export function disableUserBash(): () => never {
  return () => {
    throw new Error(
      "user_bash is disabled: host command execution is not permitted (§10.2). " +
        "Use the `bash` tool, which runs inside the sandbox VM.",
    );
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Options for {@link createRemoteTools}. */
export interface CreateRemoteToolsOptions {
  provider: SandboxProvider;
  handle: SandboxHandle;
  /** Working directory Pi resolves relative paths against (a VM path). */
  cwd: string;
  /** Per-exec timeout in seconds (default 120). */
  timeout?: number;
  /** Injected Pi `createXTool` factories (required for the six file/process tools). */
  factories: RemoteToolFactories;
  /** Options for the backend-hosted web tools. */
  web?: WebToolsOptions;
}

/** The assembled remote toolset. */
export interface RemoteToolset {
  /** Tool name → Pi-compatible tool object. */
  tools: Record<string, unknown>;
  /** The remote operations bundle (exposed for direct testing / introspection). */
  operations: ReturnType<typeof createRemoteOperations>;
  /** Marker: `user_bash` must be disabled by registering {@link disableUserBash}. */
  userBashDisabled: true;
}

/**
 * Construct all seven remote tools + the web tools, asserting at construction that
 * none of the six Pi-backed tools is left on default (host) operations.
 *
 * Returns the toolset map keyed by tool name. The session manager registers each tool
 * against the Pi `AgentSession` and registers {@link disableUserBash} on `user_bash`.
 */
export function createRemoteTools(opts: CreateRemoteToolsOptions): RemoteToolset {
  const { provider, handle, cwd, factories, web } = opts;
  const operations = createRemoteOperations({
    provider,
    handle,
    timeout: opts.timeout,
  });

  // Six Pi-backed tools — each MUST receive a remote operations object (§10.2).
  const tools: Record<string, unknown> = {
    bash: factories.createBashTool(cwd, {
      operations: assertRemoteOperations("bash", operations.bash),
    }),
    read: factories.createReadTool(cwd, {
      operations: assertRemoteOperations("read", operations.read),
    }),
    write: factories.createWriteTool(cwd, {
      operations: assertRemoteOperations("write", operations.write),
    }),
    edit: factories.createEditTool(cwd, {
      operations: assertRemoteOperations("edit", operations.edit),
    }),
    find: factories.createFindTool(cwd, {
      operations: assertRemoteOperations("find", operations.find),
    }),
    ls: factories.createLsTool(cwd, {
      operations: assertRemoteOperations("ls", operations.ls),
    }),
    // grep: custom remote tool (see module docstring / reported contradiction).
    grep: createRemoteGrepTool({ provider, handle, cwd, timeout: opts.timeout }),
  };

  // Backend-hosted web tools (not sandboxed; SSRF-guarded).
  const webTools = createWebTools(web);
  tools.web_fetch = webTools.web_fetch;
  tools.web_search = webTools.web_search;

  return { tools, operations, userBashDisabled: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

// Re-export the spill policy for callers that wrap their own tools.
export { maybeSpillLargeOutput };
/** Stable id helper (exposed for tests that assert spill-file naming). */
export function spillId(): string {
  return randomUUID();
}
