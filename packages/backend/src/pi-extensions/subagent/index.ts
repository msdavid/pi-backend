/**
 * Subagent managed Pi extension (WP-3.1, spec §18).
 *
 * A {@link createSubagentExtension} factory returns a Pi `ExtensionFactory` that
 * registers an `subagent` tool the coordinator's LLM can call. The tool mirrors the
 * Pi `examples/extensions/subagent/` reference pattern — three modes:
 *
 * - **single**: `{ agent, task }` — one subagent.
 * - **parallel**: `{ tasks: [{agent, task}, …] }` — N subagents, concurrent.
 * - **chain**: `{ chain: [{agent, task}, …] }` — sequential, `{previous}` replaced.
 *
 * Unlike the CLI example (which spawns `pi` processes), this extension delegates to
 * the in-process {@link SubagentCoordinator}, which spawns child `AgentSession`s via
 * the {@link AgentSessionFactory}. Child threads do NOT load this extension (§18.2
 * depth-1-only): their materials carry no subagent `extensionFactories`.
 *
 * **TypeBox note:** `registerTool` expects a TypeBox `TSchema` for `parameters`.
 * TypeBox is a transitive dep of `@earendil-works/pi-coding-agent` (not a direct
 * backend dep), so we construct a permissive JSON-Schema-shaped object and cast it.
 * This path is only exercised by a real Pi `AgentSession`; the orchestration itself
 * is unit-tested directly against the {@link SubagentCoordinator} (see
 * `__tests__/subagent.test.ts`).
 */

import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  ChainStep,
  SubagentCoordinator,
  SubagentResult,
  SubagentTask,
} from "../../domain/multiagent/coordinator.js";

/** Details payload for the subagent tool result (mirrors the reference example). */
export interface SubagentToolDetails {
  mode: "single" | "parallel" | "chain";
  results: SubagentResult[];
}

/** Options for {@link createSubagentExtension}. */
export interface SubagentExtensionOptions {
  /** The coordinator that owns the primary thread + roster. */
  coordinator: SubagentCoordinator;
}

/**
 * Build the subagent extension factory. Add the returned factory to the primary
 * thread's `extensionFactories` at materialization.
 */
export function createSubagentExtension(
  opts: SubagentExtensionOptions,
): ExtensionFactory {
  const { coordinator } = opts;
  return (pi: ExtensionAPI): void => {
    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description: [
        "Delegate tasks to specialized subagents with isolated context (§18).",
        "Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous}).",
        "One level of delegation only; child agents cannot delegate further.",
      ].join(" "),
      // Permissive JSON-Schema-shaped parameters (see TypeBox note above). The
      // whole tool object is cast to ToolDefinition because typebox (TSchema) is a
      // transitive dep, not directly importable from the backend.
      parameters: SUBAGENT_PARAMS,
      async execute(
        _toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
      ): Promise<AgentToolResult<SubagentToolDetails>> {
        const mode = detectMode(params);
        let results: SubagentResult[];
        let modeLabel: "single" | "parallel" | "chain";

        if (mode === "chain") {
          modeLabel = "chain";
          results = await coordinator.runChain(params.chain as ChainStep[]);
        } else if (mode === "parallel") {
          modeLabel = "parallel";
          results = await coordinator.runParallel(params.tasks as SubagentTask[]);
        } else {
          modeLabel = "single";
          const r = await coordinator.runSingle(
            String(params.agent),
            String(params.task),
          );
          results = [r];
        }

        if (signal?.aborted) {
          return {
            content: [{ type: "text", text: "Subagent execution aborted." }],
            details: { mode: modeLabel, results },
            terminate: true,
          };
        }

        const text = synthesize(results, modeLabel);
        const isError = results.some((r) => r.isError);
        const result: AgentToolResult<SubagentToolDetails> = {
          content: [{ type: "text", text }],
          details: { mode: modeLabel, results },
        };
        if (isError) (result as { isError?: boolean }).isError = true;
        return result;
      },
    } as unknown as ToolDefinition);
  };
}

/** Detect which of single/parallel/chain the params specify (exactly one). */
function detectMode(
  params: Record<string, unknown>,
): "single" | "parallel" | "chain" {
  const hasChain = Array.isArray(params.chain) && params.chain.length > 0;
  const hasTasks = Array.isArray(params.tasks) && params.tasks.length > 0;
  const hasSingle = Boolean(params.agent && params.task);
  if (hasChain) return "chain";
  if (hasTasks) return "parallel";
  if (hasSingle) return "single";
  throw new Error(
    "subagent: provide exactly one of {agent+task}, {tasks[]}, or {chain[]}",
  );
}

/** Synthesize the tool-result text from subagent results (condensed). */
function synthesize(
  results: SubagentResult[],
  mode: "single" | "parallel" | "chain",
): string {
  if (results.length === 0) return "(no results)";
  if (mode === "single") {
    const r = results[0];
    return r.isError ? `Agent failed (${r.stopReason}): ${r.output}` : r.output;
  }
  const ok = results.filter((r) => !r.isError).length;
  const parts = results.map((r) => {
    const status = r.isError ? `failed (${r.stopReason})` : "completed";
    return `### [${r.agent}] ${status}\n\n${r.output || "(no output)"}`;
  });
  return `${mode}: ${ok}/${results.length} succeeded\n\n${parts.join("\n\n---\n\n")}`;
}

/**
 * Permissive parameters schema (JSON-Schema-shaped; cast to TSchema at use). This
 * mirrors the reference example's `SubagentParams` (single/parallel/chain) without a
 * direct typebox dependency.
 */
const SUBAGENT_PARAMS = {
  type: "object",
  properties: {
    agent: { type: "string", description: "Name of the agent to invoke (single mode)." },
    task: { type: "string", description: "Task to delegate (single mode)." },
    tasks: {
      type: "array",
      description: "Array of {agent, task} for parallel execution.",
      items: {
        type: "object",
        properties: {
          agent: { type: "string" },
          task: { type: "string" },
        },
      },
    },
    chain: {
      type: "array",
      description: "Array of {agent, task} for sequential execution ({previous} placeholder).",
      items: {
        type: "object",
        properties: {
          agent: { type: "string" },
          task: { type: "string" },
        },
      },
    },
  },
  additionalProperties: false,
} as const;
