/**
 * Control levels + tool execution (WP-4.2, §10.4).
 *
 * Two control levels for executing a claimed work item:
 *  - `builtin`: the worker runs tools directly on its host (subprocess/bash).
 *    Simplest — no isolation, the host IS the sandbox.
 *  - `spawn`:   the worker hands the whole work item (+ tool calls) to a
 *    user-supplied spawn script on stdin; the script is responsible for
 *    per-session sandbox isolation (e.g. spinning up a container) and returns
 *    results as JSON on stdout.
 *
 * Work item + tool-call shapes mirror the backend wire contract
 * (`domain/self-hosted/work-queue.ts`). They are re-declared locally: the worker
 * is a standalone package and must not depend on backend internals.
 */

import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { spawn } from "node:child_process";

const exec = promisify(execCb);

/** A tool call extracted from a work spec. Opaque input — tool-interpreted. */
export interface ToolCall {
  id?: string;
  tool: string;
  input: unknown;
}

/** A tool execution result. Maps to a `user.tool_result` event (§9.2). */
export interface ToolResult {
  tool: string;
  output?: unknown;
  /** Present when the tool failed to execute (vs. a tool that ran and errored). */
  error?: string;
}

/** The work specification (opaque to the queue; the worker interprets it). */
export interface WorkSpec {
  initialEvents?: unknown[];
  config?: Record<string, unknown>;
  /** Optional inline tool calls (worker extension). */
  toolCalls?: ToolCall[];
  [key: string]: unknown;
}

/** A claimed work item (wire shape from `POST /work-claim`). */
export interface WorkItem {
  id: string;
  sessionId: string;
  environmentId: string;
  status: "queued" | "claimed" | "done" | "stopped";
  workSpec: WorkSpec;
  results: unknown[];
  claimedBy: string | null;
  claimedAt: string | null;
  queuedAt: string;
  completedAt: string | null;
  stopRequested: "clean" | "force" | null;
  stopRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** An executor turns a claimed work item into a list of tool results. */
export interface Executor {
  readonly level: "builtin" | "spawn";
  execute(item: WorkItem): Promise<ToolResult[]>;
}

/**
 * Extract tool calls from a work spec. Looks under `config.toolCalls` first
 * (the control plane's structured channel), then a top-level `toolCalls`. Falls
 * back to `[]` — a work item with no tool calls is a no-op (the worker acks and
 * moves on; the control plane drives the turn via `initialEvents`).
 */
export function extractToolCalls(spec: WorkSpec | undefined | null): ToolCall[] {
  if (!spec) return [];
  const fromConfig = spec.config?.toolCalls;
  if (Array.isArray(fromConfig)) return fromConfig as ToolCall[];
  if (Array.isArray(spec.toolCalls)) return spec.toolCalls;
  return [];
}

/**
 * Out-of-the-box executor: runs tools directly on the host.
 *
 * Supports a single built-in tool today:
 *  - `bash`:  `input.command` (string) run via `child_process.exec`. Output
 *    is `{stdout, stderr, exitCode}`. A non-zero exit is a tool result (not an
 *    executor error) — the agent sees the failure and can react.
 *
 * Unknown tools produce an `error` result (not a throw) so one bad call doesn't
 * abort the whole work item.
 */
export class BuiltinExecutor implements Executor {
  readonly level = "builtin" as const;
  /** Max stdout/stderr capture per bash call (default 1 MiB). */
  private readonly maxBuffer: number;

  constructor(opts?: { maxBuffer?: number }) {
    this.maxBuffer = opts?.maxBuffer ?? 1024 * 1024;
  }

  async execute(item: WorkItem): Promise<ToolResult[]> {
    const calls = extractToolCalls(item.workSpec);
    const results: ToolResult[] = [];
    for (const call of calls) {
      results.push(await this.runOne(call));
    }
    return results;
  }

  private async runOne(call: ToolCall): Promise<ToolResult> {
    if (call.tool === "bash") {
      const input = call.input as { command?: string } | undefined;
      const command = input?.command;
      if (typeof command !== "string" || command.length === 0) {
        return { tool: call.tool, error: "bash tool requires input.command (string)" };
      }
      try {
        const { stdout, stderr } = await exec(command, { maxBuffer: this.maxBuffer });
        return { tool: call.tool, output: { stdout, stderr, exitCode: 0 } };
      } catch (err) {
        // exec rejects on non-zero exit; capture stdout/stderr/exitCode anyway.
        const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
        return {
          tool: call.tool,
          output: { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.code ?? 1 },
        };
      }
    }
    return { tool: call.tool, error: `unsupported tool: ${call.tool} (builtin supports: bash)` };
  }
}

/** JSON envelope the spawn script returns on stdout (one line, compact JSON). */
export interface SpawnScriptResponse {
  results: ToolResult[];
}

/**
 * Spawn-script hand-off executor: hands each claimed session to a user-supplied
 * spawn script for per-session sandbox isolation.
 *
 * Protocol:
 *  - The script is invoked as `spawnScript <sessionId> <environmentId>` with
 *    `{ workItem, toolCalls }` written to its stdin as a single JSON line.
 *  - The script returns results on stdout as a single JSON line:
 *    `{"results": [{"tool": "...", "output": ...}, ...]}`.
 *  - Non-zero exit / invalid JSON → a single synthetic `error` result is
 *    returned (the work item is still acked; the control plane sees the failure).
 *
 * The script owns isolation (containers, microVMs, …); the worker only ferries
 * the work item + collects results.
 */
export class SpawnExecutor implements Executor {
  readonly level = "spawn" as const;
  private readonly spawnScript: string;

  constructor(spawnScript: string) {
    this.spawnScript = spawnScript;
  }

  async execute(item: WorkItem): Promise<ToolResult[]> {
    const toolCalls = extractToolCalls(item.workSpec);
    const payload = JSON.stringify({ workItem: item, toolCalls });

    return new Promise<ToolResult[]>((resolve) => {
      const child = spawn(this.spawnScript, [item.sessionId, item.environmentId], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });

      child.on("error", (err) => {
        resolve([{ tool: "spawn", error: `failed to launch spawn script: ${err.message}` }]);
      });
      child.on("close", (code) => {
        if (code !== 0) {
          resolve([{
            tool: "spawn",
            error: `spawn script exited with code ${code}: ${stderr.trim()}`,
          }]);
          return;
        }
        const line = stdout.trim().split("\n").pop() ?? "";
        if (!line) {
          resolve([{ tool: "spawn", error: "spawn script returned no output" }]);
          return;
        }
        try {
          const parsed = JSON.parse(line) as SpawnScriptResponse;
          if (!Array.isArray(parsed.results)) {
            resolve([{ tool: "spawn", error: "spawn script response missing results array" }]);
            return;
          }
          resolve(parsed.results);
        } catch (err) {
          resolve([{
            tool: "spawn",
            error: `spawn script returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
          }]);
        }
      });

      child.stdin.end(payload);
    });
  }
}
