/**
 * Session outputs (WP-1.12, §16.6, §24.8).
 *
 * The agent writes deliverable files to `/mnt/session/outputs/` inside its sandbox
 * (§16.6). This module enumerates and fetches those files **while the session is
 * idle** — the `remote_read_outputs` surface (§24.8). This is a minimal slice
 * pulled forward per the implementation plan: outputs are read live from the
 * sandbox via `SandboxProvider.exec`. The full reconciliation (registering outputs
 * as `files` rows so they're fetchable through `GET /v1/files?sessionId=`, §16.6
 * "Deliverables") lands in Phase 3.
 *
 * **Idle-only enforcement:** outputs can only be read when the session is `idle`
 * — a `running`/`rescheduling`/`terminated` session yields `409 session_not_idle`.
 * (Idle sandboxes are checkpointed; the Phase-3 reconciler will start/exec/stop
 * the sandbox. The fakes used in tests exec regardless of status, so this slice
 * is exercised without that lifecycle dance.)
 */

import { type Pool, type TenantCtx } from "../../infra/db/index.js";
import { ApiError } from "../errors.js";
import { fetchSessionRow } from "../session/session-repo.js";
import type {
  ExecResult,
  ObjectStore,
  SandboxHandle,
  SandboxProvider,
} from "../ports.js";

/** Outputs directory inside the sandbox (§16.6). */
export const OUTPUTS_DIR = "/mnt/session/outputs/";

/**
 * Resolves the sandbox handle for a session. The session row stores a sandbox
 * handle reference lazily (provisioned on first `user.message`, §6.3); this accessor
 * is injected so the file domain does not depend on the session runtime (WP-1.5).
 * Returns `null` when the session has no sandbox yet (no outputs to read).
 */
export interface SessionSandboxResolver {
  resolve(tenantCtx: TenantCtx, sessionId: string): Promise<SandboxHandle | null>;
}

/** A downloadable output file reference (minimal slice — name only). */
export interface SessionOutputRef {
  name: string;
}

/** Result of {@link downloadSessionOutput}. */
export interface SessionOutputDownload {
  name: string;
  stream: ReadableStream<Uint8Array>;
}

/**
 * Resolve an idle session for an outputs operation. Throws `404 not_found` if the
 * session is absent / archived, and `409 session_not_idle` unless it is `idle`.
 */
async function requireIdleSession(
  pool: Pool,
  tenantCtx: TenantCtx,
  sessionId: string,
) {
  const row = await fetchSessionRow(pool, tenantCtx, sessionId);
  if (!row || row.status === "archived") {
    throw new ApiError(404, "not_found", `session not found: ${sessionId}`);
  }
  if (row.status !== "idle") {
    throw new ApiError(
      409,
      "session_not_idle",
      `session must be idle to read outputs (current status: ${row.status})`,
    );
  }
  return row;
}

/**
 * List the output files in an idle session's sandbox. Enumerates
 * `/mnt/session/outputs/` via `ls -1`. Returns an empty list when the directory is
 * absent (no outputs written yet) or the session has no sandbox handle.
 */
export async function listSessionOutputs(
  pool: Pool,
  tenantCtx: TenantCtx,
  provider: SandboxProvider,
  resolver: SessionSandboxResolver,
  sessionId: string,
): Promise<{ data: SessionOutputRef[] }> {
  await requireIdleSession(pool, tenantCtx, sessionId);
  const handle = await resolver.resolve(tenantCtx, sessionId);
  if (!handle) return { data: [] };

  const res = await execSafe(provider, handle, { cmd: ["ls", "-1", OUTPUTS_DIR] });
  // Non-zero exit (e.g. directory missing) → no outputs yet.
  if (res.exitCode !== 0) return { data: [] };
  const names = res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return { data: names.map((name) => ({ name })) };
}

/**
 * Download a single output file from an idle session's sandbox. `filename` must be a
 * bare basename — path traversal (`/`, `..`) is rejected with `422 invalid_request`.
 * The filename is passed as a single argv element (not interpolated into a shell
 * string), so shell metacharacters cannot inject a command (§25.1). Returns the
 * content stream.
 * Throws `404 not_found` if the file does not exist in the outputs directory.
 */
export async function downloadSessionOutput(
  pool: Pool,
  tenantCtx: TenantCtx,
  provider: SandboxProvider,
  resolver: SessionSandboxResolver,
  sessionId: string,
  filename: string,
): Promise<SessionOutputDownload> {
  assertSafeBasename(filename);
  await requireIdleSession(pool, tenantCtx, sessionId);
  const handle = await resolver.resolve(tenantCtx, sessionId);
  if (!handle) {
    throw new ApiError(404, "not_found", `session has no sandbox: ${sessionId}`);
  }
  // Pass argv (not a shell string) so the filename is a single, uninterpreted
  // argument — no `sh -c`, hence no shell-metacharacter injection (§25.1). `--`
  // stops `cat` treating a filename beginning with `-` as an option.
  const res = await execSafe(provider, handle, {
    cmd: ["cat", "--", `${OUTPUTS_DIR}${filename}`],
  });
  if (res.exitCode !== 0) {
    throw new ApiError(404, "not_found", `output not found: ${filename}`);
  }
  // `cat` yields text; wrap as a byte stream. Binary-safety is a Phase-3 concern
  // (the reconciler will stream from a mounted volume rather than via `cat`).
  const bytes = new TextEncoder().encode(res.stdout);
  return { name: filename, stream: new Response(bytes).body as ReadableStream<Uint8Array> };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reject filenames that could escape the outputs directory (`/`, `..`, empty). */
function assertSafeBasename(filename: string): void {
  if (
    !filename ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename === "." ||
    filename === ".." ||
    filename.includes("..")
  ) {
    throw new ApiError(
      422,
      "invalid_request",
      `invalid output filename: ${filename}`,
    );
  }
}

/** Run an exec, mapping provider errors to a 503 (sandbox unavailable). */
async function execSafe(
  provider: SandboxProvider,
  handle: SandboxHandle,
  opts: { cmd: string | string[] },
): Promise<ExecResult> {
  try {
    return await provider.exec(handle, opts);
  } catch (err) {
    throw new ApiError(
      503,
      "internal_error",
      `sandbox unavailable: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }
}

/**
 * Object-store-backed download fallback for session outputs. Not used by the
 * minimal slice (outputs are read live from the sandbox); declared here so the
 * Phase-3 reconciler can reuse the signature when outputs become `files` rows.
 */
export async function downloadSessionOutputViaStore(
  _pool: Pool,
  _tenantCtx: TenantCtx,
  _store: ObjectStore,
  _sessionId: string,
  _filename: string,
): Promise<SessionOutputDownload> {
  throw new ApiError(501, "internal_error", "not implemented (Phase 3)");
}
