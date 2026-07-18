/**
 * Shared COLLABORATORS for the real-backend suites (contract tests here and
 * the conformance gates under `test/phase*-gate/`): scripted stand-ins for
 * the session manager and the sandbox runtime, plus the seeding/sign-in
 * helpers every suite repeats. Extracted from the WP-C2.1–C2.3 contract
 * tests so the phase-2 gate can reuse them instead of duplicating them
 * (implementation-plan rule: "a gate can import shared helpers").
 *
 * These are collaborators, not transport fakes (CONVENTIONS.md "Fakes at the
 * seam"): every suite that imports them still drives the REAL Fastify app
 * over real HTTP with the real global `fetch` — the classes below only stand
 * in for the session manager / microsandbox behind the backend's own
 * documented `CreateAppOptions` seams (`resolveRuntime` / `getActiveRuntime`
 * / `sessionEvents` / `sandboxProvider`), exactly how the composition root
 * wires the production implementations.
 */
import { Agent, Environment, Session } from "@pi-managed/contracts";
import type {
  CreateAppOptions,
  ExecChunk,
  ExecOptions,
  ExecResult,
  EntryRange,
  InboundEvent as PortsInboundEvent,
  OutboundEvent,
  SandboxHandle,
  SandboxProvider,
  SandboxStatus,
  SessionEntry as PortsSessionEntry,
  SessionRuntime,
  SessionStatus as PortsSessionStatus,
  SnapshotId,
} from "@pi-managed/backend";

import { ConsoleApiClient } from "../client.js";

export type EventsReader = NonNullable<CreateAppOptions["sessionEvents"]>;

// ---------------------------------------------------------------------------
// Session-manager stand-ins
// ---------------------------------------------------------------------------

/** In-memory `session_events` projection (the `EventsReader` seam). */
export class InMemoryProjection {
  private readonly events = new Map<string, PortsSessionEntry[]>();

  /** Append one persisted event; returns it with its assigned position. */
  append(sessionId: string, type: string, payload: unknown): PortsSessionEntry {
    const all = this.events.get(sessionId) ?? [];
    const entry: PortsSessionEntry = {
      position: all.length,
      type,
      id: `evt_${sessionId}_${all.length}`,
      createdAt: new Date().toISOString(),
      payload,
    };
    all.push(entry);
    this.events.set(sessionId, all);
    return entry;
  }

  readonly reader: EventsReader = {
    readEvents: async (_tenantId, sessionId, range?: EntryRange) => {
      const all = this.events.get(sessionId) ?? [];
      const start = range?.start ?? 0;
      const end = range?.end ?? Number.POSITIVE_INFINITY;
      const slice = all.filter((e) => e.position >= start && e.position < end);
      return range?.limit !== undefined ? slice.slice(0, range.limit) : slice;
    },
    readEventsHead: async (sessionId) =>
      (this.events.get(sessionId) ?? []).length,
  };
}

/**
 * Minimal live-tail runtime: `subscribe()` yields whatever the test pushes
 * (same single-waiter shape as testkit's `FakeSessionRuntime`). Events carry
 * their projection `position`, exactly as the production runtime stamps them
 * (`PositionedOutboundEvent`) — the SSE pipeline dedupes replay/live by it.
 */
export class LiveTailRuntime implements SessionRuntime {
  private readonly queue: OutboundEvent[] = [];
  private waiter: ((e: OutboundEvent) => void) | null = null;

  push(event: OutboundEvent & { position: number }): void {
    this.queue.push(event);
    this.pump();
  }

  private pump(): void {
    if (this.waiter && this.queue.length > 0) {
      const next = this.queue.shift()!;
      const waiter = this.waiter;
      this.waiter = null;
      waiter(next);
    }
  }

  subscribe(): AsyncIterable<OutboundEvent> {
    const queue = this.queue;
    const setWaiter = (w: (e: OutboundEvent) => void): void => {
      this.waiter = w;
    };
    const pump = (): void => this.pump();
    async function* gen(): AsyncGenerator<OutboundEvent> {
      while (queue.length > 0) yield queue.shift()!;
      while (true) {
        yield await new Promise<OutboundEvent>((resolve) => {
          setWaiter(resolve);
          pump();
        });
      }
    }
    return gen();
  }

  async wake(): Promise<void> {}
  async sendEvent(_event: PortsInboundEvent): Promise<void> {}
  async interrupt(): Promise<void> {}
  async getEntries(): Promise<PortsSessionEntry[]> {
    return [];
  }
  status(): PortsSessionStatus {
    return "running";
  }
}

/**
 * Scripted session-manager stand-in: a live tail (single-waiter queue, as
 * {@link LiveTailRuntime}) plus a `sendEvent` that records every inbound
 * event and hands it to a test-scripted reaction — the suite mirrors the
 * production confirmation flow (persist the inbound event, flip the session
 * row, emit the status event) through {@link onEvent}. Everything it emits
 * carries its projection `position`, exactly as the production runtime
 * stamps events (`PositionedOutboundEvent`).
 */
export class ConfirmingRuntime implements SessionRuntime {
  private readonly queue: OutboundEvent[] = [];
  private waiter: ((e: OutboundEvent) => void) | null = null;
  /** Every inbound event the API delivered, in order. */
  readonly received: PortsInboundEvent[] = [];
  /** Reacts to a delivered event (the test scripts the manager's behavior). */
  onEvent: ((event: PortsInboundEvent) => Promise<void>) | null = null;

  emit(event: OutboundEvent & { position: number }): void {
    this.queue.push(event);
    this.pump();
  }

  private pump(): void {
    if (this.waiter && this.queue.length > 0) {
      const next = this.queue.shift()!;
      const waiter = this.waiter;
      this.waiter = null;
      waiter(next);
    }
  }

  subscribe(): AsyncIterable<OutboundEvent> {
    const queue = this.queue;
    const setWaiter = (w: (e: OutboundEvent) => void): void => {
      this.waiter = w;
    };
    const pump = (): void => this.pump();
    async function* gen(): AsyncGenerator<OutboundEvent> {
      while (queue.length > 0) yield queue.shift()!;
      while (true) {
        yield await new Promise<OutboundEvent>((resolve) => {
          setWaiter(resolve);
          pump();
        });
      }
    }
    return gen();
  }

  async sendEvent(event: PortsInboundEvent): Promise<void> {
    this.received.push(event);
    await this.onEvent?.(event);
  }

  async wake(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async getEntries(): Promise<PortsSessionEntry[]> {
    return [];
  }
  status(): PortsSessionStatus {
    return "idle";
  }
}

// ---------------------------------------------------------------------------
// Sandbox stand-in (the outputs routes' one provider dependency)
// ---------------------------------------------------------------------------

/** Where the outputs routes look for a session's files inside the sandbox. */
export const OUTPUTS_DIR = "/mnt/session/outputs/";

/**
 * Scripted sandbox: `ls` lists {@link files}, `cat` prints one of them.
 * Only `exec` is exercised — the outputs routes' one provider dependency;
 * everything else would be a wiring bug, so it throws.
 */
export class ScriptedOutputsSandbox implements SandboxProvider {
  readonly files = new Map<string, string>();

  async exec(_handle: SandboxHandle, opts: ExecOptions): Promise<ExecResult> {
    const cmd = Array.isArray(opts.cmd) ? opts.cmd : [opts.cmd];
    if (cmd[0] === "ls") {
      return { stdout: [...this.files.keys()].join("\n"), stderr: "", exitCode: 0 };
    }
    if (cmd[0] === "cat") {
      const name = (cmd[2] ?? "").slice(OUTPUTS_DIR.length);
      const content = this.files.get(name);
      if (content === undefined) {
        return { stdout: "", stderr: `no such file: ${name}`, exitCode: 1 };
      }
      return { stdout: content, stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: `unexpected cmd: ${cmd.join(" ")}`, exitCode: 1 };
  }

  provision(): Promise<SandboxHandle> {
    throw new Error("not used by this suite");
  }
  execStream(): AsyncIterable<ExecChunk> {
    throw new Error("not used by this suite");
  }
  stop(): Promise<void> {
    throw new Error("not used by this suite");
  }
  start(): Promise<void> {
    throw new Error("not used by this suite");
  }
  snapshot(): Promise<SnapshotId> {
    throw new Error("not used by this suite");
  }
  destroy(): Promise<void> {
    throw new Error("not used by this suite");
  }
  reattachByLabels(): Promise<SandboxHandle[]> {
    throw new Error("not used by this suite");
  }
  status(): Promise<SandboxStatus> {
    throw new Error("not used by this suite");
  }
  registerSecretBinding(): Promise<void> {
    throw new Error("not used by this suite");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Poll until `predicate` holds. */
export async function until(
  predicate: () => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Real sign-in: exchange an API key for the console-session cookie. */
export async function signInCookie(
  baseUrl: string,
  apiKey: string,
): Promise<string> {
  const res = await new ConsoleApiClient({ baseUrl }).request(
    "POST",
    "/console/session",
    { body: { apiKey } },
  );
  const setCookie = res.headers.getSetCookie().find((c) => /httponly/i.test(c));
  if (!setCookie) throw new Error("no console-session cookie issued");
  return setCookie.split(";")[0]!;
}

/** Seed agent + environment + one session through the public API. */
export async function seedSession(
  admin: ConsoleApiClient,
  name: string,
): Promise<Session> {
  const agent = await admin.post(
    "/v1/agents",
    { name: `${name}-agent`, model: { provider: "anthropic", id: "claude-sonnet-4" } },
    Agent,
  );
  const env = await admin.post(
    "/v1/environments",
    { name: `${name}-env`, type: "cloud" },
    Environment,
  );
  return admin.post(
    "/v1/sessions",
    { agent: agent.id, environmentId: env.id, title: name },
    Session,
  );
}
