/**
 * Test doubles for the multiagent module (R6.4).
 *
 * No real model, no real sandbox: the coordinator's orchestration is exercised against
 * a scripted {@link FakeThreadSession} (an `AgentSessionLike`) + the
 * `FakeSandboxAllocator` from `modes.ts`. Distinct from the session-manager's
 * `FakeAgentSessionFactory`, which hands every session the SAME `sessionId` — that is
 * fine for a single-session runtime but useless here, where thread identity (and the
 * JSONL-filename race, R6.4) is exactly what is under test.
 */

import type { AgentConfig } from "@pi-managed/contracts";
import type {
  AgentSessionEventLike,
  AgentSessionFactory,
  AgentSessionLike,
  CreateAgentSessionOptions,
  SessionEntryLike,
} from "../../session-manager/types.js";
import type {
  BlockingResponse,
  BlockingThreadEvent,
  MultiagentMode,
  ResolvedRosterEntry,
  ResolvedThreadMaterial,
  ThreadCrossPostPort,
} from "../types.js";

/** A scripted per-thread `AgentSession`. */
export class FakeThreadSession implements AgentSessionLike {
  isStreaming = false;
  readonly prompts: string[] = [];
  readonly followUps: string[] = [];
  readonly steers: string[] = [];
  disposeCount = 0;
  abortCount = 0;

  private listeners: Array<(e: AgentSessionEventLike) => void> = [];
  /** Events dispatched (synchronously) during the next prompt/followUp. */
  private script: AgentSessionEventLike[] = [];
  private failWith?: Error;

  constructor(
    readonly sessionId: string,
    readonly sessionFile: string | undefined,
  ) {}

  /** Script the events emitted during the next turn. */
  scriptTurn(...events: AgentSessionEventLike[]): this {
    this.script = events;
    return this;
  }

  /** Make the next turn reject. */
  failNextTurn(err = new Error("model exploded")): this {
    this.failWith = err;
    return this;
  }

  /** A turn that emits a single assistant message. */
  scriptText(text: string): this {
    return this.scriptTurn(
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } },
      { type: "message_end" },
    );
  }

  /** A turn that raises a blocking permission request and never self-resolves. */
  scriptBlocking(toolCallId: string, toolName = "bash"): this {
    return this.scriptTurn({
      type: "blocking_request",
      toolCallId,
      toolName,
      kind: "tool_confirmation",
      input: { command: "rm -rf /" },
    });
  }

  private async turn(text: string, log: string[]): Promise<void> {
    log.push(text);
    if (this.failWith) {
      const err = this.failWith;
      this.failWith = undefined;
      throw err;
    }
    this.isStreaming = true;
    // Yield once so parallel turns genuinely interleave (the Promise.all race).
    await Promise.resolve();
    const script = this.script;
    this.script = [];
    for (const e of script) this.dispatch(e);
    this.isStreaming = false;
  }

  prompt(text: string): Promise<void> {
    return this.turn(text, this.prompts);
  }

  followUp(text: string): Promise<void> {
    return this.turn(text, this.followUps);
  }

  steer(text: string): Promise<void> {
    this.steers.push(text);
    return Promise.resolve();
  }

  subscribe(listener: (event: AgentSessionEventLike) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  abort(): Promise<void> {
    this.abortCount += 1;
    return Promise.resolve();
  }

  dispose(): void {
    this.disposeCount += 1;
  }

  getEntries(): SessionEntryLike[] {
    return [];
  }

  dispatch(event: AgentSessionEventLike): void {
    for (const l of this.listeners) l(event);
  }
}

/**
 * Factory that mints a UNIQUELY-identified session per `create()`, after an awaited
 * tick — so N `create()` calls from `runParallel`'s `Promise.all` are all in flight at
 * once (which is what made the `threads.size` filename derivation collide).
 */
export class FakeThreadSessionFactory implements AgentSessionFactory {
  readonly created: FakeThreadSession[] = [];
  readonly optionsLog: CreateAgentSessionOptions[] = [];
  /** Script applied to each new session (by creation index). */
  onCreate?: (session: FakeThreadSession, index: number) => void;
  /** If set, `create()` rejects for this creation index. */
  failAtIndex?: number;
  private seq = 0;

  async create(options: CreateAgentSessionOptions): Promise<AgentSessionLike> {
    const index = this.seq++;
    this.optionsLog.push(options);
    // Interleave: every concurrent spawn suspends here before any of them registers.
    await Promise.resolve();
    await Promise.resolve();
    if (this.failAtIndex === index) throw new Error(`factory failed at ${index}`);
    const session = new FakeThreadSession(`sess-${index}`, options.localJsonlPath);
    session.scriptText(`done: ${index}`);
    this.onCreate?.(session, index);
    this.created.push(session);
    return session;
  }

  get last(): FakeThreadSession {
    const s = this.created[this.created.length - 1];
    if (!s) throw new Error("FakeThreadSessionFactory: nothing created");
    return s;
  }
}

/** A `ThreadCrossPostPort` whose blocking round-trips are resolved by the test. */
export class ManualCrossPost implements ThreadCrossPostPort {
  readonly requests: BlockingThreadEvent[] = [];
  private readonly resolvers = new Map<string, (r: BlockingResponse) => void>();

  requestBlocking(req: BlockingThreadEvent): Promise<BlockingResponse> {
    this.requests.push(req);
    return new Promise<BlockingResponse>((resolve) => {
      this.resolvers.set(req.eventId, resolve);
    });
  }

  /** Answer a pending block (the user's `user.tool_confirmation`). */
  resolve(eventId: string, response: Partial<BlockingResponse> = {}): boolean {
    const r = this.resolvers.get(eventId);
    if (!r) return false;
    this.resolvers.delete(eventId);
    r({ kind: "tool_confirmation", eventId, decision: "allow", ...response });
    return true;
  }

  get pendingCount(): number {
    return this.resolvers.size;
  }
}

/** A minimal valid `AgentConfig` for a roster slot. */
export function fakeAgentConfig(model = "claude-sonnet-4-5"): AgentConfig {
  return {
    model,
    systemPrompt: "you are a test agent",
    tools: {},
    multiagent: { roster: [] },
  } as unknown as AgentConfig;
}

/** A resolved roster slot. */
export function fakeSlot(name: string, agentId = `agent_${name}`): ResolvedRosterEntry {
  return {
    name,
    spec: { type: "by_id", agentId },
    resolvedAgentId: agentId,
    resolvedVersion: 1,
    agentConfig: fakeAgentConfig(),
    isSelf: false,
  };
}

/** The material resolver the coordinator calls per spawn. */
export function fakeResolveMaterial(
  slot: ResolvedRosterEntry,
  _mode: MultiagentMode,
): ResolvedThreadMaterial {
  return {
    agentId: slot.resolvedAgentId,
    version: slot.resolvedVersion,
    agentConfig: slot.agentConfig,
    providerKeys: { anthropic: "sk-test" },
    cwd: "/work",
    vaultIds: [],
  };
}
