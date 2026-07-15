/**
 * Agent-session materialization (§5.2, §4.2, §9.6).
 *
 * The real {@link AgentSessionFactory}: builds a Pi `AgentSession` from a resolved
 * {@link ResolvedAgentMaterial} + a local JSONL path. Per §4.2 (per-session isolation):
 *
 * - `AuthStorage.inMemory(providerKeys)` — provider keys from the agent material,
 *   NEVER process env. Each session gets its own in-memory credential store.
 * - `ModelRegistry.inMemory(authStorage)` — built-in models only, resolved against the
 *   per-session auth storage (no `~/.pi/agent/models.json`).
 * - `SettingsManager.inMemory()` — no file I/O; the backend owns retry/compaction
 *   policy, not the user's global `~/.pi/agent/settings.json`.
 * - `DefaultResourceLoader({ cwd, systemPromptOverride, extensionFactories })` —
 *   per-session resource discovery scoped to the session cwd (§4.2).
 * - `SessionManager.open(localJsonlPath, undefined, cwd)` — bind to the existing JSONL
 *   (resume / `wake`); if absent, create a new session file in the path's directory.
 *
 * The model is resolved via `modelRegistry.find(provider, id)`; `thinkingLevel` is
 * validated against the SDK's `ThinkingLevel` union and passed through. The sandbox
 * tools (§10.2) arrive as `customTools` on the material (materialized at `wake()` once
 * the live sandbox handle exists); inline extensions arrive as `extensionFactories`.
 *
 * §10.2 host-execution lockout: `createAgentSession` is called with `noTools:"builtin"`
 * so Pi contributes NO default host-executing tools — every tool the model sees is a
 * sandbox-bound `customTool`. Construction is REFUSED if the material carries zero
 * customTools (a host-executing session would be a sandbox escape).
 *
 * §4.2 / R2.7 fail-closed: a session whose model provider has no resolved key throws a
 * non-retryable auth error BEFORE any model call, so it can never fall through to
 * pi-ai's `process.env` fallback and bill the host key.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createSyntheticSourceInfo,
  type CreateAgentSessionOptions as PiCreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSessionLike,
  AgentSessionFactory,
  CreateAgentSessionOptions,
  SessionSkill,
} from "./types.js";

/** The SDK's `ThinkingLevel` union, derived without a direct `pi-agent-core` dependency. */
type ThinkingLevel = NonNullable<PiCreateAgentSessionOptions["thinkingLevel"]>;

/**
 * The SDK's `DefaultResourceLoaderOptions` (not exported from the package root — derived
 * from the constructor, so a `^0.80.6` bump that changes the option shape breaks the
 * build rather than silently dropping an option, R1.4).
 */
type LoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

/** The valid `ThinkingLevel` values (§4.2 hint; contracts store it as a bare string). */
const THINKING_LEVELS: readonly string[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Narrow a contracts `string` thinking-level hint to the SDK union (else undefined). */
function asThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  return value !== undefined && THINKING_LEVELS.includes(value)
    ? (value as ThinkingLevel)
    : undefined;
}

/** The real factory. Constructed once and injected into the runtime. */
export class PiAgentSessionFactory implements AgentSessionFactory {
  async create(options: CreateAgentSessionOptions): Promise<AgentSessionLike> {
    const { material, localJsonlPath } = options;
    const cfg = material.agentConfig;

    // §10.2 host-execution lockout: refuse to construct a host-executing session. With
    // `noTools:"builtin"` (below) Pi contributes no default tools, so zero customTools
    // means the sandbox toolset was never materialized at wake() — construct nothing.
    if (!material.customTools || material.customTools.length === 0) {
      throw new Error(
        "PiAgentSessionFactory: refusing to construct a session with zero sandbox " +
          'tools — host-executing built-ins are suppressed (noTools:"builtin") and no ' +
          "customTools were supplied (§10.2). The sandbox toolset must be materialized " +
          "at wake() once the live handle exists.",
      );
    }

    // §4.2: per-session in-memory auth — keys from the material, never process env.
    const authStorage = AuthStorage.inMemory(buildInMemoryAuthData(material.providerKeys));

    // §4.2 / R2.7 FAIL CLOSED: a session whose model provider has no resolved key MUST
    // abort here, before any model call, so it can never fall through to pi-ai's
    // `process.env` fallback (withEnvApiKey) and bill a provider key from the host's
    // own environment.
    // (Pi's ModelRegistry.getApiKeyAndHeaders already resolves request keys with
    // `includeFallback:false`; this makes the invariant explicit and non-retryable — the
    // "auth" wording terminates the runtime's transient-retry loop instead of rescheduling.)
    if (!material.providerKeys[cfg.model.provider]) {
      throw new Error(
        `PiAgentSessionFactory: no model-provider API key resolved for provider ` +
          `"${cfg.model.provider}" (auth — non-retryable). A managed session must carry ` +
          `a tenant-owned key (vault category "model_provider_key"); the host ` +
          `environment key is never used (§4.2 / R2.7).`,
      );
    }

    const modelRegistry = ModelRegistry.inMemory(authStorage);

    const model = modelRegistry.find(cfg.model.provider, cfg.model.id);
    if (!model) {
      throw new Error(
        `PiAgentSessionFactory: model not found for provider ` +
          `"${cfg.model.provider}" / id "${cfg.model.id}" — register it in the ` +
          `model registry or supply a custom models.json (§4.2).`,
      );
    }

    // §4.2: isolated agentDir — never the user's global ~/.pi/agent (which would read
    // global settings/auth). A per-session temp dir scopes resource discovery.
    const agentDir = mkdtempSync(join(tmpdir(), "pi-session-"));

    // Per-session resource loader scoped to the session cwd (§4.2).
    const loader = buildResourceLoader(material, agentDir);
    await loader.reload();

    const sessionManager = openJsonl(localJsonlPath, material.cwd);
    const settingsManager = SettingsManager.inMemory({
      // The backend — not the user's global settings — owns retry policy.
      retry: { enabled: true, maxRetries: 3 },
    });

    const thinkingLevel = asThinkingLevel(cfg.model.thinkingLevel);
    const { session } = await createAgentSession({
      cwd: material.cwd,
      agentDir,
      model,
      ...(thinkingLevel ? { thinkingLevel } : {}),
      // §10.2: suppress Pi's default host-executing built-ins (read/bash/edit/write);
      // the model sees ONLY the sandbox-bound customTools materialized at wake().
      noTools: "builtin",
      authStorage,
      modelRegistry,
      resourceLoader: loader,
      sessionManager,
      settingsManager,
      customTools: material.customTools,
    });

    // §9.6 real mid-session system-prompt update: mutate the loader's live override holder
    // and reload so Pi rebuilds the prompt on the next turn (no `[system]` steering hack).
    const setSystemPrompt = async (content: string): Promise<void> => {
      material.systemPromptOverride = content;
      await loader.reload();
    };
    return adapt(session, agentDir, setSystemPrompt);
  }
}

/**
 * Build the per-session `DefaultResourceLoader` from the material (§4.2, §9.6, R6.5).
 * Exported so a test can assert on the loader the session actually gets (its system
 * prompt, its appended memory notes, its skills) without a model call.
 *
 * - `systemPromptOverride` is the SDK's `(base: string|undefined) => string|undefined`
 *   hook (`resource-loader.d.ts` — confirmed against 0.80.6): the loader calls it with
 *   the discovered prompt and USES the return value, so the override wins over any
 *   discovered prompt file. (Its sibling option `systemPrompt` sets the *source* the
 *   override then sees.)
 * - `appendSystemPrompt` carries the mounted memory stores' notes (R6.5a, §13.1); Pi
 *   appends them to the system prompt it rebuilds each turn.
 * - `skillsOverride` adds the session's staged skills (R6.5b, §20.4) to whatever the
 *   loader discovered, preserving Pi's native progressive disclosure.
 */
export function buildResourceLoader(
  material: CreateAgentSessionOptions["material"],
  agentDir: string,
): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd: material.cwd,
    agentDir,
    // Always install the override reading the LIVE material value (not a build-time
    // snapshot) so a mid-session `system.message` (§9.6) that mutates
    // `material.systemPromptOverride` takes effect on the next rebuild. When unset it
    // returns `base`, preserving the discovered prompt.
    systemPromptOverride: (base: string | undefined) =>
      material.systemPromptOverride ?? base,
    ...(material.appendSystemPrompt?.length
      ? { appendSystemPrompt: material.appendSystemPrompt }
      : {}),
    ...(material.skills?.length
      ? { skillsOverride: skillsOverrideFor(material.skills) }
      : {}),
    ...(material.extensionFactories
      ? { extensionFactories: material.extensionFactories }
      : {}),
  });
}

/**
 * The loader's `skillsOverride` for a session's materialized skills (R6.5b, §20.4).
 *
 * The staged skills are ADDED to whatever the loader discovered, each converted to a real
 * Pi `Skill` with a synthetic `sourceInfo` (`createSyntheticSourceInfo`, sdk.md "Skills").
 * Pi then does progressive disclosure natively: only `name` + `description` enter the
 * system prompt; the full staged `SKILL.md` at `filePath` is read on demand.
 */
function skillsOverrideFor(
  skills: SessionSkill[],
): NonNullable<LoaderOptions["skillsOverride"]> {
  return (base) => ({
    ...base,
    skills: [
      ...base.skills,
      ...skills.map((s) => ({
        name: s.name,
        description: s.description,
        filePath: s.filePath,
        baseDir: s.baseDir,
        sourceInfo: createSyntheticSourceInfo(s.filePath, {
          source: "managed",
          baseDir: s.baseDir,
        }),
        disableModelInvocation: s.disableModelInvocation ?? false,
      })),
    ],
  });
}

/**
 * Build the in-memory auth-storage data map: provider → api-key credential.
 *
 * §4.2 isolation: this iterates ONLY {@link ProviderKeys} (the per-session resolved
 * keys). It NEVER reads `process.env` (host-level provider API keys) — provider keys
 * come from the agent material, so each `AuthStorage.inMemory(...)` is fully isolated
 * from the host's global Pi config. Exported for the isolation unit test.
 */
export function buildInMemoryAuthData(
  providerKeys: Record<string, string>,
): Record<string, { type: "api_key"; key: string }> {
  const data: Record<string, { type: "api_key"; key: string }> = {};
  for (const [provider, key] of Object.entries(providerKeys)) {
    data[provider] = { type: "api_key", key };
  }
  return data;
}

/**
 * Open an existing JSONL (resume) or create a new session at the EXACT `localJsonlPath`
 * (R2.10f). `SessionManager.create(cwd, sessionDir)` alone lets Pi pick a random
 * `<timestamp>_<id>.jsonl` filename inside the dir — a filename `JsonlSync` never reads,
 * so the durable sync would upload nothing and a resume would find nothing. Pinning the
 * file via `setSessionFile` makes the runtime's sync path and Pi's write path agree.
 */
function openJsonl(
  localJsonlPath: string,
  cwd: string,
): ReturnType<typeof SessionManager.open> {
  if (existsSync(localJsonlPath)) {
    return SessionManager.open(localJsonlPath, undefined, cwd);
  }
  // First wake of a new session: create a fresh session, then pin its file to the exact
  // path the runtime syncs. The header is written to this path on the first persist.
  const manager = SessionManager.create(cwd, dirname(localJsonlPath));
  manager.setSessionFile(localJsonlPath);
  return manager;
}

/**
 * Adapt the real Pi `AgentSession` to {@link AgentSessionLike} — the only addition is
 * `getEntries()`, which proxies to `session.sessionManager.getEntries()`.
 */
function adapt(
  session: {
    readonly sessionId: string;
    readonly sessionFile: string | undefined;
    readonly isStreaming: boolean;
    prompt: (
      text: string,
      options?: { streamingBehavior?: "steer" | "followUp" },
    ) => Promise<void>;
    steer: (text: string) => Promise<void>;
    followUp: (text: string) => Promise<void>;
    subscribe: (listener: (event: unknown) => void) => () => void;
    abort: () => Promise<void>;
    dispose: () => void;
    sessionManager: { getEntries(): unknown[] };
  },
  agentDir: string,
  setSystemPrompt: (content: string) => Promise<void>,
): AgentSessionLike {
  return {
    sessionId: session.sessionId,
    get sessionFile() {
      return session.sessionFile;
    },
    get isStreaming() {
      return session.isStreaming;
    },
    prompt: (t, o) => session.prompt(t, o),
    steer: (t) => session.steer(t),
    followUp: (t) => session.followUp(t),
    subscribe: (l) => session.subscribe(l as (event: unknown) => void),
    abort: () => session.abort(),
    dispose: () => session.dispose(),
    getEntries: () => session.sessionManager.getEntries() as never,
    agentDir,
    setSystemPrompt,
  };
}

/**
 * Build a deliberately TOOL-LESS grader `AgentSession` (§16.1): its own context window,
 * a fixed grader system prompt, the graded session's model + resolved provider key, and
 * NO tools at all (`noTools:"builtin"` + zero `customTools`). Unlike a managed session,
 * zero tools is the intended, safe shape here — the grader reads its prompt and emits a
 * verdict; it executes nothing on the host or in a sandbox, so the §10.2 host-execution
 * lockout is satisfied by construction (there is nothing to execute). Fails closed on a
 * missing provider key (§4.2 / R2.7), same as the main factory. The session's throwaway
 * temp dirs are removed when it is disposed (the grader disposes after each pass).
 */
export async function createGraderSession(opts: {
  model: { provider: string; id: string; thinkingLevel?: string };
  providerKeys: Record<string, string>;
  systemPrompt: string;
}): Promise<AgentSessionLike> {
  if (!opts.providerKeys[opts.model.provider]) {
    throw new Error(
      `createGraderSession: no model-provider API key resolved for provider ` +
        `"${opts.model.provider}" (auth — non-retryable). The grader reuses the graded ` +
        `session's tenant-owned key; the host environment key is never used (§4.2 / R2.7).`,
    );
  }
  const authStorage = AuthStorage.inMemory(buildInMemoryAuthData(opts.providerKeys));
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const model = modelRegistry.find(opts.model.provider, opts.model.id);
  if (!model) {
    throw new Error(
      `createGraderSession: model not found for provider "${opts.model.provider}" / ` +
        `id "${opts.model.id}".`,
    );
  }
  const agentDir = mkdtempSync(join(tmpdir(), "pi-grader-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-grader-cwd-"));
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    systemPromptOverride: () => opts.systemPrompt,
  });
  await loader.reload();
  const jsonlPath = join(agentDir, "grader.jsonl");
  const sessionManager = SessionManager.create(cwd, agentDir);
  sessionManager.setSessionFile(jsonlPath);
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: true, maxRetries: 3 },
  });
  const thinkingLevel = asThinkingLevel(opts.model.thinkingLevel);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    // Tool-less by design (see the doc above): no sandbox, no host tools.
    noTools: "builtin",
    authStorage,
    modelRegistry,
    resourceLoader: loader,
    sessionManager,
    settingsManager,
  });
  const base = adapt(session, agentDir, async () => {
    /* the grader prompt is fixed for the session's one-shot lifetime */
  });
  // Wrap dispose to remove the grader's throwaway temp dirs (the grader disposes the
  // session after each evaluation pass, §16.1).
  return {
    ...base,
    dispose: () => {
      base.dispose();
      for (const dir of [agentDir, cwd]) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* best-effort cleanup */
        }
      }
    },
  };
}
