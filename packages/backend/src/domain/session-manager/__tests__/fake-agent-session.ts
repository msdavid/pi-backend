/**
 * Test doubles for the {@link AgentSessionFactory} seam. The real `PiAgentSessionFactory`
 * (materialize.ts) calls Pi's `createAgentSession()`, which needs a live model provider
 * and can't run in unit tests. These fakes keep the orchestration logic real: they
 * record calls + emit scripted `AgentSessionEventLike`s during `prompt()`.
 *
 * No process-global Pi config is read by any of these fakes (§4.2 isolation).
 */

import type {
  AgentSessionFactory,
  AgentSessionLike,
  AgentSessionEventLike,
  CreateAgentSessionOptions,
  SessionEntryLike,
} from "../types.js";

/** Recorded call log for assertions. */
export interface FakeAgentSessionCalls {
  prompt: string[];
  steer: string[];
  followUp: string[];
  abort: number;
  dispose: number;
}

/** A scripted `AgentSessionLike` for the runtime tests. */
export class FakeAgentSession implements AgentSessionLike {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  isStreaming = false;
  readonly calls: FakeAgentSessionsCalls = {
    prompt: [],
    steer: [],
    followUp: [],
    abort: 0,
    dispose: 0,
  };
  /** The `options` the factory received (for §4.2 isolation assertions). */
  factoryOptions?: CreateAgentSessionOptions;

  /** Per-session temp agent dir (for the dispose-cleanup test). */
  agentDir?: string;
  /** Records `setSystemPrompt` calls (the real §9.6 mid-session prompt update path). */
  readonly setSystemPromptCalls: string[] = [];

  private listeners: Array<(e: AgentSessionEventLike) => void> = [];
  private scriptedTurn: AgentSessionEventLike[] = [];
  private entries: SessionEntryLike[] = [];
  /** If set, the next `prompt()` rejects with this error (retry tests). */
  private rejectsWith?: Error;
  /** Number of times to reject before resolving (transient-retry simulation). */
  private transientFailuresLeft = 0;
  /** When true, the next `prompt()` hangs (runtime stays `running`) until released. */
  private holdPrompt = false;
  private releasePrompt?: () => void;

  constructor(sessionId = "fake-session", sessionFile?: string) {
    this.sessionId = sessionId;
    this.sessionFile = sessionFile;
  }

  /** Script the events to emit during the next `prompt()`. */
  scriptTurn(...events: AgentSessionEventLike[]): void {
    this.scriptedTurn = events;
  }

  /** Script the JSONL entries returned by `getEntries()`. */
  seedEntries(entries: SessionEntryLike[]): void {
    this.entries = [...entries];
  }

  /** Make the next `n` `prompt()` calls reject with a transient error. */
  failTransiently(n: number, message = "transient: ECONNRESET"): void {
    this.transientFailuresLeft = n;
    this.rejectsWith = new Error(message);
  }

  /** Make the next `prompt()` hang (the runtime stays `running`) until {@link release}. */
  holdNextPrompt(): void {
    this.holdPrompt = true;
  }

  /** Release a held `prompt()` so the turn settles. */
  release(): void {
    const r = this.releasePrompt;
    this.releasePrompt = undefined;
    r?.();
  }

  prompt(text: string): Promise<void> {
    this.calls.prompt.push(text);
    if (this.transientFailuresLeft > 0) {
      this.transientFailuresLeft -= 1;
      return Promise.reject(this.rejectsWith);
    }
    this.isStreaming = true;
    for (const e of this.scriptedTurn) this.dispatch(e);
    this.scriptedTurn = [];
    if (this.holdPrompt) {
      this.holdPrompt = false;
      // Stay `running` until released; the caller settles the turn with `release()`.
      return new Promise<void>((resolve) => {
        this.releasePrompt = () => {
          this.isStreaming = false;
          resolve();
        };
      });
    }
    this.isStreaming = false;
    return Promise.resolve();
  }

  steer(text: string): Promise<void> {
    this.calls.steer.push(text);
    return Promise.resolve();
  }

  followUp(text: string): Promise<void> {
    this.calls.followUp.push(text);
    return Promise.resolve();
  }

  subscribe(listener: (event: AgentSessionEventLike) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  abort(): Promise<void> {
    this.calls.abort += 1;
    return Promise.resolve();
  }

  dispose(): void {
    this.calls.dispose += 1;
  }

  getEntries(): SessionEntryLike[] {
    return this.entries;
  }

  setSystemPrompt(content: string): Promise<void> {
    this.setSystemPromptCalls.push(content);
    return Promise.resolve();
  }

  /** Dispatch an event to all subscribed listeners. */
  dispatch(event: AgentSessionEventLike): void {
    for (const l of this.listeners) l(event);
  }
}

/** Shared calls shape (typo-safe). */
export interface FakeAgentSessionsCalls {
  prompt: string[];
  steer: string[];
  followUp: string[];
  abort: number;
  dispose: number;
}

/**
 * Fake factory: records every `create()` call + the options received, and returns a
 * fresh {@link FakeAgentSession} each time (mirroring `wake()` booting a fresh session).
 * The most recent session is exposed for scripting + assertions.
 */
export class FakeAgentSessionFactory implements AgentSessionFactory {
  readonly created: FakeAgentSession[] = [];
  readonly optionsLog: CreateAgentSessionOptions[] = [];

  create(options: CreateAgentSessionOptions): Promise<AgentSessionLike> {
    this.optionsLog.push(options);
    const session = new FakeAgentSession(
      "fake-session",
      options.localJsonlPath,
    );
    session.factoryOptions = options;
    this.created.push(session);
    return Promise.resolve(session);
  }

  /** The most recently created session (for scripting the next turn). */
  get last(): FakeAgentSession {
    const s = this.created[this.created.length - 1];
    if (!s) throw new Error("FakeAgentSessionFactory: no session created yet");
    return s;
  }
}
