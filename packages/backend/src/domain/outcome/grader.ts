/**
 * Outcome grader (WP-3.2, §16.1/§16.4).
 *
 * The grader is a **separate `AgentSession`** with its own context window + the
 * rubric, reading `/mnt/session/outputs/` (§16.1). It is intentionally isolated
 * from the main agent's implementation choices (§16.1): the grader only sees the
 * produced deliverables + the rubric, never the main agent's chain-of-thought.
 *
 * This module defines the {@link Grader} seam + a reference {@link SubagentGrader}
 * implementation (materializes a grader `AgentSession` via an injected factory and
 * reads outputs through the sandbox provider's `exec`). Tests use {@link FakeGrader}
 * so the rubric-driven loop is exercised without a live model (§29.4 gate slice).
 */

import type {
  AgentSessionLike,
  AgentSessionEventLike,
} from "../session-manager/types.js";
import type {
  ExecResult,
  SandboxHandle,
  SandboxProvider,
} from "../ports.js";
import type { TenantCtx } from "../../infra/db/index.js";
import type { CriterionVerdict } from "./events.js";
import { OUTPUTS_DIR, type SessionSandboxResolver } from "../file/outputs.js";

/** Input to a grade pass. The grader reads outputs itself (§16.1 isolation). */
export interface GradeInput {
  tenantCtx: TenantCtx;
  sessionId: string;
  outcomeId: string;
  /** Which iteration is being graded (0-based). */
  iteration: number;
  /** The outcome description (what the agent was asked to produce). */
  description: string;
  /** Resolved rubric text (text rubric content, or fetched file-rubric content). */
  rubricText: string;
  /**
   * Cancels an in-flight grade (R6.3). Aborted when a `user.interrupt` lands on the
   * session stream, when the outcome is cancelled, or when the loop times out. A grader
   * that ignores it still works (the loop races the evaluation against the same signal),
   * but the {@link SubagentGrader} wires it to `AgentSession.abort()` so the grader's
   * model call actually stops instead of burning tokens for a discarded verdict.
   */
  signal?: AbortSignal;
}

/**
 * A grader's evaluation of one produced iteration.
 *
 * - `verdict: "satisfied"` — the rubric is met; the outcome is satisfied (§16.5).
 * - `verdict: "needs_revision"` — the rubric is not yet met; feedback is handed
 *   back to the main agent for the next iteration.
 * - `failed` — the rubric does not match the deliverables at all (§16.5 `failed`);
 *   the outcome goes idle without further iteration.
 */
export interface GraderEvaluation {
  verdict: "satisfied" | "needs_revision";
  criteria: CriterionVerdict[];
  feedback: string;
  /** The grader's raw assistant text (for debugging / events). */
  rawOutput?: string;
  /** Set when the grader cannot meaningfully evaluate (→ `failed`, §16.5). */
  failed?: { reason: string };
}

/** The grader seam. */
export interface Grader {
  evaluate(input: GradeInput): Promise<GraderEvaluation>;
}

// ---------------------------------------------------------------------------
// Reference implementation: SubagentGrader
// ---------------------------------------------------------------------------

/** The graded session's identity, so the factory can reuse its model + provider key. */
export interface GraderSessionContext {
  tenantCtx: TenantCtx;
  sessionId: string;
}

/**
 * Factory that materializes a fresh grader `AgentSession` (its own context window,
 * §16.1). The composition root wires the real {@link PiGraderSessionFactory} — which loads
 * the graded session's resolved model + provider key and builds a deliberately TOOL-LESS
 * session (the grader executes nothing; it reads the prompt and emits a verdict). Tests
 * inject a fake. The returned session is disposed by the grader after each evaluation
 * (one-shot context per pass, §16.1).
 */
export interface GraderSessionFactory {
  create(
    systemPromptOverride: string,
    ctx: GraderSessionContext,
  ): Promise<AgentSessionLike>;
}

/** Resolves the grader's view of the sandbox outputs (idle session). */
export interface GraderOutputsResolver {
  /** List + read all output files as a single concatenated string for the grader. */
  readOutputs(tenantCtx: TenantCtx, sessionId: string): Promise<GraderOutputs>;
}

/** The outputs the grader inspects. */
export interface GraderOutputs {
  listing: string;
  contents: string;
}

/**
 * Read outputs from an idle session's sandbox via `exec` (§16.1, §16.6). Reuses the
 * WP-1.12 outputs surface's sandbox resolver. The grader sees the same files a
 * client fetches through the Files API once idle (§16.6).
 */
export class SandboxOutputsResolver implements GraderOutputsResolver {
  constructor(
    private readonly provider: SandboxProvider,
    private readonly resolver: SessionSandboxResolver,
  ) {}

  async readOutputs(
    tenantCtx: TenantCtx,
    sessionId: string,
  ): Promise<GraderOutputs> {
    const handle = await this.resolver.resolve(tenantCtx, sessionId);
    if (!handle) return { listing: "", contents: "" };
    const list = await this.exec(handle, ["ls", "-1", OUTPUTS_DIR]);
    if (list.exitCode !== 0) return { listing: "", contents: "" };
    const names = list.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.includes("/") && !l.includes(".."));
    let contents = "";
    for (const name of names) {
      // argv array — never a shell string — so a filename containing shell
      // metacharacters (an agent-controlled name) is inert data, not code (R0.9).
      const cat = await this.exec(handle, ["cat", "--", `${OUTPUTS_DIR}${name}`]);
      contents += `----- ${name} -----\n${cat.stdout}\n`;
    }
    return { listing: list.stdout, contents };
  }

  private exec(handle: SandboxHandle, cmd: string | string[]): Promise<ExecResult> {
    return this.provider.exec(handle, { cmd });
  }
}

const GRADER_SYSTEM_PROMPT = `You are an outcome grader. You evaluate whether a set of
produced deliverables satisfies a rubric. You do NOT see the agent's reasoning — only
the deliverable files written to /mnt/session/outputs/ (provided below) and the rubric.

Respond with ONLY a fenced JSON block of shape:
\`\`\`json
{
  "verdict": "satisfied" | "needs_revision",
  "criteria": [{"criterion": "<short name>", "passed": true|false, "note": "<optional>"}],
  "feedback": "<concrete, specific feedback for the next iteration; empty if satisfied>"
}
\`\`\`
Set verdict "satisfied" only when EVERY rubric criterion is met.`;

/**
 * Reference grader: materializes a one-shot grader `AgentSession`, feeds it the
 * rubric + outputs, and parses the JSON verdict. Independent context window (§16.1).
 *
 * Not unit-tested (needs a live model) — tests use {@link FakeGrader}. Kept
 * structurally complete + typed against the session-manager seams.
 */
export class SubagentGrader implements Grader {
  constructor(
    private readonly factory: GraderSessionFactory,
    private readonly outputs: GraderOutputsResolver,
  ) {}

  async evaluate(input: GradeInput): Promise<GraderEvaluation> {
    const outputs = await this.outputs.readOutputs(input.tenantCtx, input.sessionId);
    const session = await this.factory.create(GRADER_SYSTEM_PROMPT, {
      tenantCtx: input.tenantCtx,
      sessionId: input.sessionId,
    });
    try {
      const prompt = [
        `# Outcome`,
        input.description,
        ``,
        `# Rubric`,
        input.rubricText,
        ``,
        `# Produced outputs (iteration ${input.iteration + 1})`,
        outputs.listing
          ? `Files:\n${outputs.listing}\n\n${outputs.contents}`
          : "(no output files written yet)",
        ``,
        `Evaluate against the rubric. Reply with the JSON block only.`,
      ].join("\n");

      const collector = new AssistantTextCollector();
      const unsubscribe = session.subscribe((e: AgentSessionEventLike) => {
        collector.observe(e);
      });
      // Cancellable grade (R6.3): an interrupt / timeout aborts the grader's model call.
      const onAbort = (): void => {
        void session.abort();
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await session.prompt(prompt);
      } finally {
        unsubscribe();
        input.signal?.removeEventListener("abort", onAbort);
      }
      if (input.signal?.aborted) {
        throw new OutcomeGradeAborted();
      }
      const raw = collector.text();
      const parsed = parseVerdict(raw);
      return { ...parsed, rawOutput: raw };
    } finally {
      session.dispose();
    }
  }
}

/** Thrown when a grade pass is cancelled (interrupt / cancel / timeout, R6.3). */
export class OutcomeGradeAborted extends Error {
  constructor() {
    super("outcome grade aborted");
    this.name = "OutcomeGradeAborted";
  }
}

// ---------------------------------------------------------------------------
// Assistant-text accumulation (real Pi event shapes — R6.3)
// ---------------------------------------------------------------------------

/**
 * Accumulates the grader session's assistant text from the REAL Pi `AgentSessionEvent`
 * shapes — the same mapping `session-manager/runtime.ts` performs (`onPiEvent`):
 *
 * - `message_update` carries `assistantMessageEvent: AssistantMessageEvent`; a
 *   `text_delta` variant carries the token in `.delta` (pi-ai `types.d.ts`).
 * - `message_end` carries the finished `message: AgentMessage` and flushes the buffer.
 *
 * The previous implementation guessed at `event.data.text` / `event.data.content`, which
 * no Pi event has — so it always collected `""` and every verdict fell through to
 * `parseVerdict("")` → `failed`. Non-streaming providers may emit no deltas at all, so
 * `message_end` also falls back to the assistant message's `text` content blocks.
 */
export class AssistantTextCollector {
  private buffer = "";
  private readonly messages: string[] = [];

  /** Feed one agent-session event. */
  observe(event: AgentSessionEventLike): void {
    if (event.type === "message_update") {
      const ame = (event as { assistantMessageEvent?: { type?: string; delta?: unknown } })
        .assistantMessageEvent;
      if (ame?.type === "text_delta" && typeof ame.delta === "string") {
        this.buffer += ame.delta;
      }
      return;
    }
    if (event.type === "message_end") {
      const message = (event as { message?: { role?: string; content?: unknown } }).message;
      // Only assistant messages carry the verdict (user/toolResult messages also end).
      if (message && message.role !== "assistant") {
        return;
      }
      const text = this.buffer || messageText(message);
      this.buffer = "";
      if (text) this.messages.push(text);
    }
  }

  /** The concatenated assistant text seen so far (incl. an unflushed partial). */
  text(): string {
    return [...this.messages, this.buffer].join("");
  }
}

/** Extract the `text` content blocks of a Pi `AssistantMessage` (pi-ai `TextContent`). */
function messageText(message: { content?: unknown } | undefined): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (c): c is { type: "text"; text: string } =>
        typeof c === "object" &&
        c !== null &&
        (c as { type?: unknown }).type === "text" &&
        typeof (c as { text?: unknown }).text === "string",
    )
    .map((c) => c.text)
    .join("");
}

/** Parse the grader's fenced JSON verdict block. Falls back to `failed`. */
export function parseVerdict(raw: string): GraderEvaluation {
  const fence = raw.match(/```json\s*([\s\S]*?)```/i) ?? raw.match(/```\s*([\s\S]*?)```/i);
  const jsonText = fence ? fence[1] : raw;
  const start = jsonText.indexOf("{");
  const end = jsonText.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return {
      verdict: "needs_revision",
      criteria: [],
      feedback: "",
      failed: { reason: "grader returned no parseable JSON" },
    };
  }
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(jsonText.slice(start, end + 1));
  } catch {
    return {
      verdict: "needs_revision",
      criteria: [],
      feedback: "",
      failed: { reason: "grader JSON did not parse" },
    };
  }
  const verdict = obj.verdict === "satisfied" ? "satisfied" : "needs_revision";
  const criteria = Array.isArray(obj.criteria)
    ? (obj.criteria as Array<Record<string, unknown>>).map((c) => ({
        criterion: String(c.criterion ?? "criterion"),
        passed: Boolean(c.passed),
        ...(c.note ? { note: String(c.note) } : {}),
      }))
    : [];
  const feedback = typeof obj.feedback === "string" ? obj.feedback : "";
  return { verdict, criteria, feedback };
}

// ---------------------------------------------------------------------------
// Fake grader (tests)
// ---------------------------------------------------------------------------

/** A scriptable grader for the iteration-loop tests (§29.4 gate slice). */
export class FakeGrader implements Grader {
  private scripts: GraderEvaluation[] = [];
  private callCount = 0;
  readonly calls: GradeInput[] = [];

  /** Queue the next evaluation(s) to return, in order. */
  script(...evaluations: GraderEvaluation[]): void {
    this.scripts.push(...evaluations);
  }

  evaluate(input: GradeInput): Promise<GraderEvaluation> {
    this.calls.push(input);
    const next = this.scripts[this.callCount];
    this.callCount += 1;
    const result =
      next ?? { verdict: "needs_revision", criteria: [], feedback: "no script" };
    return Promise.resolve(result);
  }

  get invocationCount(): number {
    return this.callCount;
  }
}
