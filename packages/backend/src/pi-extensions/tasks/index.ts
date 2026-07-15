/**
 * Tasks managed-feature Pi extension (spec §14).
 *
 * A lightweight, PER-SESSION task list the agent uses to track multi-step work
 * within a session. NOT a cross-session project-management system (use memory
 * stores for that, §13).
 *
 * Pi-native implementation (§14.2, following examples/extensions/todo.ts):
 * - State is stored in tool result `details` (not external files) so it is
 *   BRANCHING-CORRECT — forking a session forks the task state with it.
 * - State is reconstructed on `session_start`/`session_tree` by scanning the
 *   session branch for the task tool's result entries.
 * - The agent gets a `todo` tool (create/update/list/get/delete with status
 *   pending/in_progress/completed).
 *
 * Only one task should be in_progress at a time (the activeForm present-continuous
 * label). Deleting a session does not affect other resources (§14.3 per-session).
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface Task {
  id: number;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed";
}

export interface TaskDetails {
  action: "create" | "update" | "list" | "get" | "delete";
  tasks: Task[];
  nextId: number;
  error?: string;
}

const TaskParams = Type.Object({
  action: Type.Union([
    Type.Literal("create"),
    Type.Literal("update"),
    Type.Literal("list"),
    Type.Literal("get"),
    Type.Literal("delete"),
  ]),
  subject: Type.Optional(Type.String({ description: "Short imperative title (create/update)." })),
  description: Type.Optional(Type.String({ description: "Detailed requirements + done condition (create/update)." })),
  id: Type.Optional(Type.Number({ description: "Task ID (update/get/delete)." })),
  status: Type.Optional(
    Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
  ),
});

export default function (pi: ExtensionAPI): void {
  let tasks: Task[] = [];
  let nextId = 1;

  /** Reconstruct task state from the session branch (§14.2 branch-scan). */
  const reconstructState = (ctx: ExtensionContext) => {
    tasks = [];
    nextId = 1;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;
      const details = msg.details as TaskDetails | undefined;
      if (details) {
        tasks = details.tasks;
        nextId = details.nextId;
      }
    }
  };

  pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
  pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

  pi.registerTool({
    name: "todo",
    label: "Task list",
    description:
      "Manage a per-session task list for tracking multi-step work within this session. " +
      "Actions: create (subject + description), update (id + status/subject/description), " +
      "list, get (id), delete (id). Status: pending → in_progress → completed. " +
      "Only one task should be in_progress at a time. State is branching-correct " +
      "(forking the session forks the task state). Not for cross-session work " +
      "(use memory stores for that).",
    parameters: TaskParams,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      switch (params.action) {
        case "list":
          return {
            content: [
              {
                type: "text",
                text: tasks.length
                  ? tasks.map((t) => `[${t.status}] #${t.id}: ${t.subject}`).join("\n")
                  : "No tasks",
              },
            ],
            details: { action: "list", tasks: [...tasks], nextId } as TaskDetails,
          };

        case "create": {
          if (!params.subject) {
            return {
              content: [{ type: "text", text: "Error: subject required for create" }],
              details: { action: "create", tasks: [...tasks], nextId, error: "subject required" } as TaskDetails,
            };
          }
          const task: Task = {
            id: nextId++,
            subject: params.subject,
            description: params.description ?? "",
            status: "pending",
          };
          tasks.push(task);
          return {
            content: [{ type: "text", text: `Created task #${task.id}: ${task.subject}` }],
            details: { action: "create", tasks: [...tasks], nextId } as TaskDetails,
          };
        }

        case "update": {
          if (params.id === undefined) {
            return {
              content: [{ type: "text", text: "Error: id required for update" }],
              details: { action: "update", tasks: [...tasks], nextId, error: "id required" } as TaskDetails,
            };
          }
          const task = tasks.find((t) => t.id === params.id);
          if (!task) {
            return {
              content: [{ type: "text", text: `Task #${params.id} not found` }],
              details: { action: "update", tasks: [...tasks], nextId, error: `#${params.id} not found` } as TaskDetails,
            };
          }
          if (params.subject !== undefined) task.subject = params.subject;
          if (params.description !== undefined) task.description = params.description;
          if (params.status !== undefined) {
            // Only one in_progress at a time.
            if (params.status === "in_progress") {
              for (const t of tasks) if (t.id !== task.id && t.status === "in_progress") t.status = "pending";
            }
            task.status = params.status;
          }
          return {
            content: [{ type: "text", text: `Updated task #${task.id} (${task.status})` }],
            details: { action: "update", tasks: [...tasks], nextId } as TaskDetails,
          };
        }

        case "get": {
          if (params.id === undefined) {
            return {
              content: [{ type: "text", text: "Error: id required for get" }],
              details: { action: "get", tasks: [...tasks], nextId, error: "id required" } as TaskDetails,
            };
          }
          const task = tasks.find((t) => t.id === params.id);
          return {
            content: [
              { type: "text", text: task ? `#${task.id} [${task.status}] ${task.subject}\n${task.description}` : `Task #${params.id} not found` },
            ],
            details: { action: "get", tasks: [...tasks], nextId } as TaskDetails,
          };
        }

        case "delete": {
          if (params.id === undefined) {
            return {
              content: [{ type: "text", text: "Error: id required for delete" }],
              details: { action: "delete", tasks: [...tasks], nextId, error: "id required" } as TaskDetails,
            };
          }
          const before = tasks.length;
          tasks = tasks.filter((t) => t.id !== params.id);
          return {
            content: [{ type: "text", text: `Deleted task #${params.id} (${before - tasks.length} removed)` }],
            details: { action: "delete", tasks: [...tasks], nextId } as TaskDetails,
          };
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown action: ${params.action}` }],
            details: { action: "list", tasks: [...tasks], nextId, error: `unknown action` } as TaskDetails,
          };
      }
    },
  });
}
