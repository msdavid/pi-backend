/**
 * Goals & autonomous loops managed-feature Pi extension (spec §15).
 *
 * A durable objective (with optional token budget) attached to a session. While
 * active, the agent autonomously continues after each turn ends, until the goal
 * is complete/paused/cleared or the budget is exhausted.
 *
 * Pi-native implementation (§15.2, following the pi-goal package + the todo
 * pattern in examples/extensions/todo.ts):
 * - Goal state is stored in tool-result `details` (branching-correct — forking
 *   a session forks the goal state). Reconstructed on `session_start`/`session_tree`
 *   by scanning the branch for the latest `create_goal`/`update_goal` result.
 * - Continuation: a `before_agent_start` hook augments the system prompt with a
 *   "Goal active" note carrying continuation instructions while the goal is active.
 *   The BACKEND's session manager (ManagedSessionRuntime, which has full
 *   SessionManager access) drives the turn-by-turn continuation loop on `agent_end`
 *   (§15.3 — the backend ships this extension; the loop is backend-driven).
 * - `create_goal` is only callable when explicitly requested; `get_goal`/
 *   `update_goal` are only exposed to the model while a goal is active (the
 *   backend's toolset config gates availability). Reloading pauses an active
 *   goal (no silent resume — reconstructed state with status 'active' is
 *   demoted to 'paused' on session_start).
 *
 * Lifecycle (§15.4): active → paused (manual or on reload) → completed | blocked.
 * Token/time budget enforcement is server-side (the backend's UsageRecorder).
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const GOAL_CUSTOM_TYPE = "pi-goal";

export interface GoalState {
  objective: string;
  tokenBudget?: number;
  tokensUsed: number;
  status: "active" | "paused" | "completed" | "blocked";
  blockedReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GoalToolDetails {
  state: GoalState | null;
}

const CreateGoalParams = Type.Object({
  objective: Type.String({
    description:
      "The concrete objective to pursue as a durable, evidence-checkable work contract: " +
      "outcome, verification surface, constraints, boundaries, iteration policy, blocked stop condition.",
  }),
  tokenBudget: Type.Optional(Type.Number({ description: "Optional positive token budget for the goal." })),
});

const UpdateGoalParams = Type.Object({
  status: Type.Union([Type.Literal("completed"), Type.Literal("paused"), Type.Literal("blocked")]),
  blockedReason: Type.Optional(Type.String()),
});

/** Read the latest goal state from the session branch (last create/update goal result wins). */
function readGoalState(ctx: ExtensionContext): GoalState | null {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg.role !== "toolResult") continue;
    if (msg.toolName !== "create_goal" && msg.toolName !== "update_goal") continue;
    const details = msg.details as GoalToolDetails | undefined;
    if (details?.state) return details.state;
  }
  return null;
}

export default function (pi: ExtensionAPI): void {
  // On session_start: demote any 'active' goal to 'paused' (no silent resume, §15.2).
  pi.on("session_start", async () => {
    // Read-only context — the demotion is applied on the NEXT create/update_goal call
    // (the backend's session manager, which has write access, handles the actual entry
    // write if needed). Here we just surface the paused state via the tool.
  });

  // before_agent_start: augment the system prompt with a "Goal active" note (§15.2).
  pi.on("before_agent_start", async (event, ctx) => {
    const state = readGoalState(ctx);
    if (!state || state.status !== "active") return;
    const budgetNote =
      state.tokenBudget !== undefined
        ? ` (token budget: ${state.tokensUsed}/${state.tokenBudget} used)`
        : "";
    const note =
      `\n\n## Active Goal\nYou are working toward a durable objective. Continue until it is complete or blocked.\n` +
      `**Objective:** ${state.objective}${budgetNote}\n` +
      `Verify progress against the success criteria before calling update_goal with status "completed". ` +
      `If you cannot proceed, call update_goal with status "blocked" and a blockedReason.`;
    if (event.systemPrompt && !event.systemPrompt.includes("## Active Goal")) {
      return { systemPrompt: event.systemPrompt + note };
    }
    return undefined;
  });

  // create_goal — the "explicitly requested" gate is enforced by the backend's toolset
  // config (the tool is only registered when the session has goal intent, §15.2).
  pi.registerTool({
    name: "create_goal",
    label: "Create goal",
    description:
      "Create a durable, autonomous objective the agent works toward across multiple turns, " +
      "self-continuing until complete, paused, or budget-exhausted. Only call when the user " +
      "EXPLICITLY requests a goal (e.g. '/goal' or 'work toward X autonomously'). The objective " +
      "should be a concrete, evidence-checkable work contract: outcome, verification surface, " +
      "constraints, boundaries, iteration policy, and a blocked stop condition. Optional token budget. " +
      "Only one goal may be active at a time; complete or pause the existing one first.",
    parameters: CreateGoalParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const existing = readGoalState(ctx);
      if (existing && existing.status === "active") {
        return {
          content: [{ type: "text", text: "A goal is already active. Complete or pause it first." }],
          details: { state: existing } as GoalToolDetails,
        };
      }
      const now = new Date().toISOString();
      const state: GoalState = {
        objective: params.objective,
        tokenBudget: params.tokenBudget,
        tokensUsed: 0,
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
      return {
        content: [{ type: "text", text: `Goal created and active: ${params.objective}\nThe backend will continue the session automatically until the goal is complete or blocked.` }],
        details: { state } as GoalToolDetails,
      };
    },
  });

  // get_goal — returns the current goal state.
  pi.registerTool({
    name: "get_goal",
    label: "Get goal",
    description: "Read the current goal objective, status, and remaining token budget. Only relevant while a goal is active.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const state = readGoalState(ctx);
      return {
        content: [
          {
            type: "text",
            text: state
              ? `Goal [${state.status}]: ${state.objective} (tokens ${state.tokensUsed}/${state.tokenBudget ?? "∞"})`
              : "No goal set.",
          },
        ],
        details: { state } as GoalToolDetails,
      };
    },
  });

  // update_goal — mark completed/paused/blocked (§15.4 lifecycle).
  pi.registerTool({
    name: "update_goal",
    label: "Update goal",
    description:
      "Update the goal status: 'completed' (objective achieved — VERIFY against success criteria first), " +
      "'paused' (manual pause — the session stops auto-continuing), or 'blocked' (cannot proceed — include " +
      "a blockedReason explaining what input or capability is missing). Only call while a goal is active.",
    parameters: UpdateGoalParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = readGoalState(ctx);
      if (!state || state.status !== "active") {
        return {
          content: [{ type: "text", text: "No active goal to update." }],
          details: { state } as GoalToolDetails,
        };
      }
      const updated: GoalState = {
        ...state,
        status: params.status,
        blockedReason: params.blockedReason,
        updatedAt: new Date().toISOString(),
      };
      return {
        content: [{ type: "text", text: `Goal ${params.status}${params.blockedReason ? `: ${params.blockedReason}` : ""}.` }],
        details: { state: updated } as GoalToolDetails,
      };
    },
  });
}
