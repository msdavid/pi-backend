/**
 * @pi-managed/client — `/remote:*` commands (spec §24, §24.7).
 *
 * Commands:
 * - `/remote:start [agent] [env]` — start a fresh interactive session, open the
 *   live-view panel, forward subsequent local prompts as `user.message`.
 * - `/remote:resume <sessionId>` — resume an idle session interactively.
 * - `/remote:sessions` — list remote sessions (status/title/last activity/usage).
 * - `/remote:delegate <task>` — create a session + initial `user.message`, open
 *   the panel, return the session ID. Runs to completion even if local Pi
 *   closes (the backend is the executor).
 * - `/remote:attach <sessionId>` — attach the panel to a running delegated session
 *   (interactive steering).
 * - `/remote:fork <sessionId>` — fork a session.
 *
 * The run* functions are decoupled from Pi types (deps-injected) so they can be
 * unit-tested against a mock client + in-memory recorder. `registerRemoteCommands`
 * wires them into Pi and is RPC-invokable.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { Session } from "@pi-managed/contracts";
import { ManagedApiClient, ApiClientError } from "../api-client.js";
import {
  PiAuthStorageAdapter,
  resolveApiKey,
  resolveBackendUrl,
} from "../auth.js";
import {
  defaultSettingsPath,
  loadSettingsFile,
  resolveConfig,
} from "../config.js";
import {
  DelegationRecorder,
} from "../panel/delegation.js";
import {
  PiDelegationDedupStore,
  defaultDedupPath,
} from "../panel/dedup-store.js";
import {
  surfaceOfflineCompletions,
  type PanelUi,
} from "../panel/connection.js";
import {
  detachConnection,
  detachPanel,
  getActiveInteractive,
  setActiveInteractive,
  startLivePanel,
} from "../panel/live-view.js";
import { forwardPrompt } from "../panel/forwarding.js";
import { delegationEntryRenderer } from "../panel/entry-renderer.js";
import { DELEGATION_CUSTOM_TYPE } from "../panel/types.js";
import type { DelegationMode } from "../panel/types.js";

/** UI slice the commands need (structural subset of ctx.ui). */
export interface RemoteUi extends PanelUi {
  input(title: string, placeholder?: string): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  select(title: string, options: string[]): Promise<string | undefined>;
}

/** Dependencies for the run* functions (all injectable for testing). */
export interface RemoteCommandDeps {
  ui: RemoteUi;
  recorder: DelegationRecorder;
  /** Build an authenticated client, or undefined if the backend isn't configured. */
  createClient(): ManagedApiClient | undefined;
  /** Defaults for agent/environment when not passed on the command line. */
  defaultAgent?: string;
  defaultEnvironment?: string;
  /** Open the live-view panel for a session. */
  startPanel(sessionId: string, mode: DelegationMode): void;
}

// --- arg parsing ------------------------------------------------------------

function parseArgs(args: string): string[] {
  return args.trim().split(/\s+/).filter((t) => t !== "");
}

function notConfigured(ui: RemoteUi): void {
  ui.notify(
    "Pi Managed Backend is not configured. Run /remote:config first.",
    "error",
  );
}

function catchClientError(ui: RemoteUi, e: unknown, what: string): boolean {
  if (e instanceof ApiClientError) {
    ui.notify(`${what} failed: ${e.message}`, "error");
    return true;
  }
  return false;
}

// --- /remote:start ----------------------------------------------------------

export async function runStart(deps: RemoteCommandDeps, args: string): Promise<void> {
  const [agentArg, envArg] = parseArgs(args);
  const client = deps.createClient();
  if (!client) return notConfigured(deps.ui);
  const agent = agentArg ?? deps.defaultAgent;
  const environmentId = envArg ?? deps.defaultEnvironment;
  if (!agent || !environmentId) {
    deps.ui.notify(
      "Usage: /remote:start [agentId] [environmentId] — set defaults via /remote:config or pass both.",
      "error",
    );
    return;
  }
  let session: Session;
  try {
    session = await client.createSession({ agent, environmentId });
  } catch (e) {
    if (catchClientError(deps.ui, e, "Starting session")) return;
    throw e;
  }
  deps.recorder.appendStart(session.id, "", "interactive");
  deps.ui.notify(`Started remote session ${session.id}.`, "info");
  deps.startPanel(session.id, "interactive");
}

// --- /remote:resume ---------------------------------------------------------

export async function runResume(deps: RemoteCommandDeps, args: string): Promise<void> {
  const [sessionId] = parseArgs(args);
  const client = deps.createClient();
  if (!client) return notConfigured(deps.ui);
  if (!sessionId) {
    deps.ui.notify("Usage: /remote:resume <sessionId>", "error");
    return;
  }
  let session: Session;
  try {
    session = await client.getSession(sessionId);
  } catch (e) {
    if (catchClientError(deps.ui, e, "Resuming session")) return;
    throw e;
  }
  if (session.status === "terminated") {
    deps.ui.notify(`Session ${sessionId} is terminated — cannot resume.`, "error");
    return;
  }
  deps.recorder.appendStart(session.id, "", "interactive");
  deps.ui.notify(`Resumed remote session ${session.id} (${session.status}).`, "info");
  deps.startPanel(session.id, "interactive");
}

// --- /remote:sessions -------------------------------------------------------

export async function runSessions(deps: RemoteCommandDeps): Promise<void> {
  const client = deps.createClient();
  if (!client) return notConfigured(deps.ui);
  let page;
  try {
    page = await client.listSessions({ limit: 50 });
  } catch (e) {
    if (catchClientError(deps.ui, e, "Listing sessions")) return;
    throw e;
  }
  if (page.data.length === 0) {
    deps.ui.notify("No remote sessions.", "info");
    return;
  }
  const lines = ["Remote sessions:"];
  for (const s of page.data) {
    const title = s.title ?? "(untitled)";
    lines.push(`  ${s.id} · ${s.status} · ${title} · last ${s.lastActivityAt}`);
  }
  deps.ui.setWidget("pi-managed:sessions", lines.slice(0, 50));
  deps.ui.setStatus("pi-managed", `${page.data.length} session(s)`);
}

// --- /remote:delegate -------------------------------------------------------

export async function runDelegate(deps: RemoteCommandDeps, args: string): Promise<void> {
  const task = args.trim();
  const client = deps.createClient();
  if (!client) return notConfigured(deps.ui);
  if (!task) {
    deps.ui.notify("Usage: /remote:delegate <task>", "error");
    return;
  }
  if (!deps.defaultAgent || !deps.defaultEnvironment) {
    deps.ui.notify(
      "Delegate requires default agent + environment (set via /remote:config).",
      "error",
    );
    return;
  }
  let session: Session;
  try {
    session = await client.createSession({
      agent: deps.defaultAgent,
      environmentId: deps.defaultEnvironment,
      title: task.slice(0, 128),
    });
  } catch (e) {
    if (catchClientError(deps.ui, e, "Creating delegated session")) return;
    throw e;
  }
  try {
    await client.sendEvent(session.id, { type: "user.message", content: task });
  } catch (e) {
    if (catchClientError(deps.ui, e, "Sending task to delegated session")) return;
    throw e;
  }
  // The FIRST durable entry (start marker). The SECOND (completion summary) is
  // appended by the connection manager when the session reaches idle/terminated.
  deps.recorder.appendStart(session.id, task, "delegate");
  deps.ui.notify(
    `Delegated to ${session.id}. The session runs to completion even if this Pi closes.`,
    "info",
  );
  deps.startPanel(session.id, "delegate");
}

// --- /remote:attach ---------------------------------------------------------

export async function runAttach(deps: RemoteCommandDeps, args: string): Promise<void> {
  const [sessionId] = parseArgs(args);
  const client = deps.createClient();
  if (!client) return notConfigured(deps.ui);
  if (!sessionId) {
    deps.ui.notify("Usage: /remote:attach <sessionId>", "error");
    return;
  }
  let session: Session;
  try {
    session = await client.getSession(sessionId);
  } catch (e) {
    if (catchClientError(deps.ui, e, "Attaching to session")) return;
    throw e;
  }
  if (session.status === "terminated") {
    deps.ui.notify(`Session ${sessionId} is terminated.`, "error");
    return;
  }
  // Attach in interactive mode so the user can steer. If a start marker is
  // absent (e.g. attaching to a session created elsewhere), record one now.
  if (!deps.recorder.hasStarted(sessionId)) {
    deps.recorder.appendStart(sessionId, "", "interactive");
  }
  deps.ui.notify(
    `Attached to ${sessionId} (${session.status}). Type to steer; /remote:detach to release.`,
    "info",
  );
  deps.startPanel(sessionId, "interactive");
}

// --- /remote:fork -----------------------------------------------------------

export async function runFork(deps: RemoteCommandDeps, args: string): Promise<void> {
  const [sessionId] = parseArgs(args);
  const client = deps.createClient();
  if (!client) return notConfigured(deps.ui);
  if (!sessionId) {
    deps.ui.notify("Usage: /remote:fork <sessionId>", "error");
    return;
  }
  let forked: Session;
  try {
    forked = await client.forkSession(sessionId);
  } catch (e) {
    if (catchClientError(deps.ui, e, "Forking session")) return;
    throw e;
  }
  deps.ui.notify(`Forked ${sessionId} → ${forked.id}.`, "info");
}

// --- /remote:detach (helper) ------------------------------------------------

export async function runDetach(deps: RemoteCommandDeps, args: string): Promise<void> {
  const [sessionId] = parseArgs(args);
  const id = sessionId ?? getActiveInteractive();
  if (!id) {
    deps.ui.notify("No remote panel attached.", "info");
    return;
  }
  detachConnection(id);
  detachPanel(id);
  if (getActiveInteractive() === id) setActiveInteractive(undefined);
  deps.ui.notify(`Detached from ${id}.`, "info");
}

// --- Pi wiring -------------------------------------------------------------

/** Resolve settings from an extension context (shared by `/remote:*` commands). */
export function settingsFor(ctx: ExtensionContext) {
  return resolveConfig(loadSettingsFile(defaultSettingsPath(ctx.cwd)));
}

/** Build a client from an extension context (shared by `/remote:*` commands). */
export function buildClientFromContext(ctx: ExtensionContext): ManagedApiClient | undefined {
  const settings = settingsFor(ctx);
  const authStore = new PiAuthStorageAdapter(ctx.modelRegistry.authStorage);
  const apiKey = resolveApiKey(settings, authStore);
  const backendUrl = resolveBackendUrl(settings);
  if (!backendUrl || !apiKey) return undefined;
  return new ManagedApiClient({
    backendUrl,
    getApiKey: () => apiKey,
    pollingIntervalMs: settings.pollingIntervalMs,
    streamTimeoutMs: settings.streamTimeoutMs,
  });
}

/**
 * Register all `/remote:*` commands + the delegation entry renderer + the
 * interactive input-forwarding hook with Pi. RPC-invokable.
 */
export function registerRemoteCommands(pi: ExtensionAPI): void {
  const append = <T = unknown>(customType: string, data?: T): void => {
    pi.appendEntry(customType, data);
  };
  // Persist dedup state beside settings.json so the "exactly 2 entries" invariant
  // and offline-completion dedup survive a Pi restart (R3.3).
  const dedupStore = new PiDelegationDedupStore(defaultDedupPath());
  const recorder = new DelegationRecorder(append, undefined, dedupStore);

  const deps = (ctx: ExtensionCommandContext): RemoteCommandDeps => ({
    ui: ctx.ui,
    recorder,
    createClient: () => buildClientFromContext(ctx),
    defaultAgent: settingsFor(ctx).defaultAgent,
    defaultEnvironment: settingsFor(ctx).defaultEnvironment,
    startPanel: (sessionId, mode) => {
      const client = buildClientFromContext(ctx);
      if (!client) {
        ctx.ui.notify("Backend connection lost; cannot open panel.", "error");
        return;
      }
      startLivePanel({
        apiClient: client,
        ui: ctx.ui,
        recorder,
        sessionId,
        mode,
      });
    },
  });

  pi.registerCommand("remote:start", {
    description: "Start a fresh interactive remote session (spec §24).",
    handler: async (args, ctx) => runStart(deps(ctx), args),
  });
  pi.registerCommand("remote:resume", {
    description: "Resume an idle remote session interactively.",
    handler: async (args, ctx) => runResume(deps(ctx), args),
  });
  pi.registerCommand("remote:sessions", {
    description: "List remote sessions (status/title/last activity).",
    handler: async (_args, ctx) => runSessions(deps(ctx)),
  });
  pi.registerCommand("remote:delegate", {
    description: "Delegate a task to a remote session that runs to completion.",
    handler: async (args, ctx) => runDelegate(deps(ctx), args),
  });
  pi.registerCommand("remote:attach", {
    description: "Attach the live-view panel to a running remote session.",
    handler: async (args, ctx) => runAttach(deps(ctx), args),
  });
  pi.registerCommand("remote:fork", {
    description: "Fork a remote session (shares the JSONL tree to the fork point).",
    handler: async (args, ctx) => runFork(deps(ctx), args),
  });
  pi.registerCommand("remote:detach", {
    description: "Detach the live-view panel from a remote session.",
    handler: async (args, ctx) => runDetach(deps(ctx), args),
  });

  // Visual layer for the two durable delegation entries (see entry-renderer.ts).
  pi.registerEntryRenderer(DELEGATION_CUSTOM_TYPE, delegationEntryRenderer);

  // Interactive forwarding: when an interactive panel is focused, local prompts
  // (non-slash) are forwarded to the remote session as user.message. Delegate
  // panels never set the active interactive session, so they are autonomous.
  pi.on("input", async (event, ctx) => {
    const text = event.text?.trim() ?? "";
    if (!text || text.startsWith("/")) return { action: "continue" };
    const sessionId = getActiveInteractive();
    if (!sessionId) return { action: "continue" };
    const client = buildClientFromContext(ctx);
    if (!client) return { action: "continue" };
    const forwarded = await forwardPrompt(client, sessionId, "interactive", text);
    return forwarded ? { action: "handled" } : { action: "continue" };
  });

  // On startup, surface sessions that completed while Pi was offline (§24.9).
  pi.on("session_start", async (_event, ctx) => {
    const client = buildClientFromContext(ctx);
    if (!client) return;
    try {
      await surfaceOfflineCompletions(client, recorder);
    } catch {
      // Best-effort; never block startup on a network hiccup.
    }
  });
}
