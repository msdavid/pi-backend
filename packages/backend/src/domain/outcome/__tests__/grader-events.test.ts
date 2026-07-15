/**
 * Grader event-parsing tests (R6.3).
 *
 * The grader used to guess at `event.data.text` / `event.data.content` — shapes NO Pi
 * `AgentSessionEvent` has. It therefore collected `""` on every pass, and `parseVerdict("")`
 * fails closed → every outcome graded `failed`. These tests pin the grader to the REAL
 * event shapes (pi-coding-agent `extensions/types.d.ts` + pi-ai `types.d.ts`):
 *
 *   { type: "message_update", message, assistantMessageEvent: { type: "text_delta", delta, ... } }
 *   { type: "message_end", message: AssistantMessage }
 *
 * — the same mapping `session-manager/runtime.ts#onPiEvent` performs. The assertions are
 * that a NON-EMPTY verdict is parsed from a real streamed grader reply, and that
 * `parseVerdict` still fails closed on garbage.
 */

import { describe, expect, it } from "vitest";
import {
  AssistantTextCollector,
  OutcomeGradeAborted,
  SubagentGrader,
  parseVerdict,
  type GraderOutputs,
  type GraderOutputsResolver,
  type GraderSessionFactory,
} from "../grader.js";
import type {
  AgentSessionEventLike,
  AgentSessionLike,
  SessionEntryLike,
} from "../../session-manager/types.js";
import type { TenantCtx } from "../../../infra/db/index.js";

const CTX: TenantCtx = { tenantId: "t_1" };

// --- real Pi event builders -------------------------------------------------

/** A real `MessageUpdateEvent` carrying an `AssistantMessageEvent` text delta. */
function textDelta(delta: string, contentIndex = 0): AgentSessionEventLike {
  return {
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: delta }] },
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex,
      delta,
      partial: { role: "assistant", content: [{ type: "text", text: delta }] },
    },
  };
}

/** A real `MessageUpdateEvent` carrying a THINKING delta (must NOT be collected). */
function thinkingDelta(delta: string): AgentSessionEventLike {
  return {
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta, partial: {} },
  };
}

/** A real `MessageEndEvent` for an assistant message. */
function messageEnd(text: string): AgentSessionEventLike {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
    },
  };
}

/** A real `MessageEndEvent` for a non-assistant message (user / toolResult). */
function userMessageEnd(text: string): AgentSessionEventLike {
  return {
    type: "message_end",
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

const VERDICT_JSON = `\`\`\`json
{
  "verdict": "satisfied",
  "criteria": [{"criterion": "async-await", "passed": true, "note": "all callbacks gone"}],
  "feedback": ""
}
\`\`\``;

// --- a grader AgentSession fake that emits REAL Pi events --------------------

class ScriptedGraderSession implements AgentSessionLike {
  readonly sessionId = "grader_1";
  readonly sessionFile = undefined;
  isStreaming = false;
  disposed = false;
  aborted = false;
  readonly prompts: string[] = [];
  private listeners: ((e: AgentSessionEventLike) => void)[] = [];

  constructor(
    private readonly script: AgentSessionEventLike[],
    private readonly opts: { hang?: boolean } = {},
  ) {}

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    for (const event of this.script) {
      for (const l of this.listeners) l(event);
    }
    if (this.opts.hang) {
      // Never settles until aborted (models the "grade in flight" case).
      await new Promise<void>((resolve) => {
        this.resolveHang = resolve;
      });
    }
  }
  private resolveHang: (() => void) | undefined;

  async steer(): Promise<void> {}
  async followUp(): Promise<void> {}
  subscribe(listener: (event: AgentSessionEventLike) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
  async abort(): Promise<void> {
    this.aborted = true;
    this.resolveHang?.();
  }
  dispose(): void {
    this.disposed = true;
  }
  getEntries(): SessionEntryLike[] {
    return [];
  }
}

function makeGrader(
  script: AgentSessionEventLike[],
  opts: { hang?: boolean; outputs?: GraderOutputs } = {},
): { grader: SubagentGrader; session: ScriptedGraderSession } {
  const session = new ScriptedGraderSession(script, { ...(opts.hang ? { hang: true } : {}) });
  const factory: GraderSessionFactory = { create: async () => session };
  const outputs: GraderOutputsResolver = {
    readOutputs: async () =>
      opts.outputs ?? { listing: "report.md\n", contents: "----- report.md -----\nhi\n" },
  };
  return { grader: new SubagentGrader(factory, outputs), session };
}

const INPUT = {
  tenantCtx: CTX,
  sessionId: "sess_1",
  outcomeId: "outc_1",
  iteration: 0,
  description: "Refactor auth.ts",
  rubricText: "- callbacks converted",
};

describe("AssistantTextCollector — real Pi event shapes (R6.3)", () => {
  it("accumulates text_delta from message_update and flushes on message_end", () => {
    const c = new AssistantTextCollector();
    c.observe({ type: "agent_start" });
    c.observe({ type: "turn_start", turnIndex: 0 });
    c.observe(textDelta("Hello "));
    c.observe(thinkingDelta("(pondering)"));
    c.observe(textDelta("world"));
    c.observe(messageEnd("Hello world"));
    expect(c.text()).toBe("Hello world");
  });

  it("falls back to the assistant message's text blocks when no deltas streamed", () => {
    const c = new AssistantTextCollector();
    c.observe(messageEnd("non-streamed reply"));
    expect(c.text()).toBe("non-streamed reply");
  });

  it("ignores non-assistant message_end (user / toolResult)", () => {
    const c = new AssistantTextCollector();
    c.observe(userMessageEnd("the prompt echoed back"));
    expect(c.text()).toBe("");
  });

  it("collects nothing from the shapes the old parser guessed at", () => {
    const c = new AssistantTextCollector();
    // The pre-R6.3 code read these; no Pi event has them.
    c.observe({ type: "assistant_message", data: { text: "ghost" } });
    expect(c.text()).toBe("");
  });
});

describe("SubagentGrader — parses a verdict from real streamed events (R6.3)", () => {
  it("parses a NON-EMPTY satisfied verdict streamed as text_delta events", async () => {
    // The verdict arrives token-by-token, exactly as Pi streams it.
    const chunks = VERDICT_JSON.match(/[\s\S]{1,7}/g)!;
    const { grader, session } = makeGrader([
      ...chunks.map((ch) => textDelta(ch)),
      messageEnd(VERDICT_JSON),
    ]);

    const evaluation = await grader.evaluate(INPUT);

    // Load-bearing: the raw text is non-empty (the old grader collected "").
    expect(evaluation.rawOutput).toContain('"verdict"');
    expect(evaluation.rawOutput!.length).toBeGreaterThan(0);
    expect(evaluation.failed).toBeUndefined();
    expect(evaluation.verdict).toBe("satisfied");
    expect(evaluation.criteria).toEqual([
      { criterion: "async-await", passed: true, note: "all callbacks gone" },
    ]);
    // The grader saw the rubric + the outputs (§16.1 isolation: outputs, not reasoning).
    expect(session.prompts[0]).toContain("- callbacks converted");
    expect(session.prompts[0]).toContain("report.md");
    expect(session.disposed).toBe(true);
  });

  it("parses needs_revision + feedback (drives the next iteration)", async () => {
    const raw = '```json\n{"verdict":"needs_revision","criteria":[{"criterion":"c","passed":false}],"feedback":"convert the login callback"}\n```';
    const { grader } = makeGrader([textDelta(raw), messageEnd(raw)]);
    const evaluation = await grader.evaluate(INPUT);
    expect(evaluation.verdict).toBe("needs_revision");
    expect(evaluation.feedback).toBe("convert the login callback");
    expect(evaluation.failed).toBeUndefined();
  });

  it("fails closed when the grader emits no assistant text at all", async () => {
    const { grader } = makeGrader([{ type: "agent_end", messages: [] }]);
    const evaluation = await grader.evaluate(INPUT);
    expect(evaluation.failed?.reason).toContain("no parseable JSON");
  });

  it("aborts the grader session when the grade is cancelled mid-flight", async () => {
    const { grader, session } = makeGrader([], { hang: true });
    const controller = new AbortController();
    const pending = grader.evaluate({ ...INPUT, signal: controller.signal });
    // Let `prompt()` reach its hang, then cancel (interrupt / timeout / cancel route).
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(OutcomeGradeAborted);
    expect(session.aborted).toBe(true);
    expect(session.disposed).toBe(true);
  });
});

describe("parseVerdict — fail-closed behavior preserved", () => {
  it("treats empty output as failed", () => {
    expect(parseVerdict("").failed).toBeDefined();
  });
  it("treats unparseable JSON as failed", () => {
    expect(parseVerdict("```json\n{nope\n```").failed).toBeDefined();
  });
  it("defaults an unknown verdict string to needs_revision", () => {
    const v = parseVerdict('{"verdict":"lgtm","criteria":[],"feedback":"f"}');
    expect(v.verdict).toBe("needs_revision");
    expect(v.failed).toBeUndefined();
  });
});
