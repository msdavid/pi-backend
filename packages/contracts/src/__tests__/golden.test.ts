/**
 * Golden tests — validate representative example payloads (copied from
 * docs/api-reference.md) against the contracts schemas, plus security invariants.
 */

import { describe, it, expect } from "vitest";
import {
  Agent,
  AgentCreate,
  Environment,
  EnvironmentCreate,
  Session,
  SessionCreate,
  SessionUsageResponse,
  UserMessageEvent,
  UserToolConfirmationEvent,
  UserDefineOutcomeEvent,
  SessionStatusIdleEvent,
  AgentToolUseEvent,
  AgentToolResultEvent,
  EventStartFrame,
  EventDeltaFrame,
  Vault,
  VaultCreate,
  CredentialCreate,
  Credential,
  MemoryStore,
  MemoryStoreCreate,
  MemoryVersion,
  File,
  Skill,
  Outcome,
  OutcomeCreate,
  Job,
  JobCreate,
  JobRun,
  Webhook,
  WebhookCreate,
  WebhookCreateResponse,
  WebhookTestResponse,
  WebhookPayload,
  TenantInfo,
  ApiKey,
  ApiKeyCreateResponse,
  ErrorEnvelope,
  Cursor,
  agentId,
  envId,
} from "../index.js";

describe("golden payloads (positive)", () => {
  it("Agent create + resource", () => {
    const create = {
      name: "code-reviewer",
      model: { provider: "anthropic", id: "claude-sonnet-4", thinkingLevel: "high" },
      systemPrompt: "You are a meticulous code reviewer…",
      tools: {
        defaultConfig: { enabled: true, permissionPolicy: "always_allow" },
        configs: { bash: { permissionPolicy: "always_ask" } },
      },
      skills: [{ type: "prebuilt", skillId: "skill_01JAZZZZZZZZZZZZZZZZZZZZZZ" }],
      extensions: [],
      mcpServers: [],
      multiagent: { roster: [] },
      metadata: { team: "platform" },
    };
    expect(AgentCreate.parse(create)).toEqual(create);

    const resource = {
      id: "agent_01JAZZZZZZZZZZZZZZZZZZZZZZ",
      name: "code-reviewer",
      currentVersion: 1,
      status: "active",
      createdAt: "2026-07-13T12:00:00Z",
      updatedAt: "2026-07-13T12:00:00Z",
      metadata: { team: "platform" },
    };
    expect(Agent.parse(resource)).toEqual(resource);
  });

  it("Environment create + resource", () => {
    const create = {
      name: "python-env",
      type: "cloud",
      image: "ubuntu:22.04",
      resources: { cpus: 2, memoryMiB: 2048, diskMiB: 10240 },
      networking: { mode: "unrestricted" },
      packages: ["python3", "pip"],
      mounts: [],
      maxDuration: 3600,
      idleTimeout: 300,
      metadata: {},
    };
    expect(EnvironmentCreate.parse(create)).toEqual(create);

    const resource = {
      id: "env_01JAZZZZZZZZZZZZZZZZZZZZZZ",
      name: "python-env",
      type: "cloud",
      status: "active",
      networking: { mode: "unrestricted" },
      createdAt: "2026-07-13T12:00:00Z",
      updatedAt: "2026-07-13T12:00:00Z",
    };
    expect(Environment.parse(resource)).toEqual(resource);

    // limited networking discriminant
    expect(
      EnvironmentCreate.parse({
        name: "limited-env",
        type: "cloud",
        networking: { mode: "limited", allowedHosts: ["api.github.com"] },
      }).networking,
    ).toEqual({ mode: "limited", allowedHosts: ["api.github.com"] });
  });

  it("Session create (3 agent forms) + resource", () => {
    // Form 1 — bare ID
    const f1 = SessionCreate.parse({
      agent: "agent_01JAZZZZZZZZZZZZZZZZZZZZZZ",
      environmentId: "env_01JAZZZZZZZZZZZZZZZZZZZZZZ",
      title: "fix the login bug",
      resources: [],
      vaultIds: ["vault_01JAZZZZZZZZZZZZZZZZZZZZZZ"],
      budget: { maxTokens: 1000000, maxUsd: 2.0 },
      metadata: { userId: "u_123" },
    });
    expect(f1.agent).toBe("agent_01JAZZZZZZZZZZZZZZZZZZZZZZ");

    // Form 2 — pinned version
    SessionCreate.parse({
      agent: { id: "agent_01JAZZZZZZZZZZZZZZZZZZZZZZ", version: 3 },
      environmentId: "env_01JAZZZZZZZZZZZZZZZZZZZZZZ",
    });

    // Form 3 — overrides
    SessionCreate.parse({
      agent: {
        id: "agent_01JAZZZZZZZZZZZZZZZZZZZZZZ",
        overrides: { model: { provider: "openai", id: "gpt-4o" } },
      },
      environmentId: "env_01JAZZZZZZZZZZZZZZZZZZZZZZ",
    });

    const resource = {
      id: "sess_01JAZZZZZZZZZZZZZZZZZZZZZZ",
      agentId: "agent_01JAZZZZZZZZZZZZZZZZZZZZZZ",
      agentVersion: 3,
      environmentId: "env_01JAZZZZZZZZZZZZZZZZZZZZZZ",
      title: "fix the login bug",
      status: "idle",
      stopReason: null,
      budget: { maxTokens: 1000000, maxUsd: 2.0 },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      vaultIds: ["vault_01JAZZZZZZZZZZZZZZZZZZZZZZ"],
      resources: [],
      metadata: { userId: "u_123" },
      createdAt: "2026-07-13T12:00:00Z",
      updatedAt: "2026-07-13T12:00:00Z",
      lastActivityAt: "2026-07-13T12:00:00Z",
      forkedFromSessionId: null,
    };
    expect(Session.parse(resource)).toEqual(resource);
  });

  it("Session usage", () => {
    const u = {
      inputTokens: 12345,
      outputTokens: 6789,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      usdCost: 0.12,
    };
    expect(SessionUsageResponse.parse(u)).toEqual(u);
  });

  it("Inbound events", () => {
    expect(UserMessageEvent.parse({ type: "user.message", content: "Fix the login bug" }))
      .toEqual({ type: "user.message", content: "Fix the login bug" });
    expect(
      UserToolConfirmationEvent.parse({
        type: "user.tool_confirmation",
        eventId: "evt_01JAZZZZZZZZZZZZZZZZZZZZZZ",
        decision: "allow",
      }),
    ).toEqual({
      type: "user.tool_confirmation",
      eventId: "evt_01JAZZZZZZZZZZZZZZZZZZZZZZ",
      decision: "allow",
    });
    expect(
      UserDefineOutcomeEvent.parse({
        type: "user.define_outcome",
        description: "Refactor auth.ts to use async/await",
        rubric: { type: "text", content: "…rubric markdown…" },
        maxIterations: 3,
      }),
    ).toMatchObject({ type: "user.define_outcome", maxIterations: 3 });
  });

  it("Outbound events + stream deltas", () => {
    expect(
      SessionStatusIdleEvent.parse({
        type: "session.status_idle",
        stopReason: "requires_action",
        blockingEventIds: ["evt_01JAZZZZZZZZZZZZZZZZZZZZZZ"],
        processedAt: "2026-07-13T12:00:00Z",
      }),
    ).toMatchObject({ stopReason: "requires_action" });

    expect(
      AgentToolUseEvent.parse({
        type: "agent.tool_use",
        tool: "bash",
        input: { cmd: "ls" },
        eventId: "evt_01JAZZZZZZZZZZZZZZZZZZZZZZ",
        processedAt: "2026-07-13T12:00:00Z",
      }),
    ).toMatchObject({ tool: "bash" });

    expect(
      AgentToolResultEvent.parse({
        type: "agent.tool_result",
        tool: "bash",
        output: "file1.ts\nfile2.ts",
        truncated: false,
        processedAt: "2026-07-13T12:00:00Z",
      }),
    ).toMatchObject({ truncated: false });

    expect(
      EventStartFrame.parse({ eventId: "evt_01JAZZZZZZZZZZZZZZZZZZZZZZ", type: "agent.message" }),
    ).toMatchObject({ type: "agent.message" });
    expect(
      EventDeltaFrame.parse({
        eventId: "evt_01JAZZZZZZZZZZZZZZZZZZZZZZ",
        index: 0,
        text: "Fixing ",
      }),
    ).toMatchObject({ index: 0 });
  });

  it("Vault + credential (write-only invariant: response omits secrets)", () => {
    expect(VaultCreate.parse({ name: "gh", metadata: {} })).toMatchObject({ name: "gh" });
    expect(
      Vault.parse({
        id: "vault_01JAZZZZZZZZZZZZZZZZZZZZZZ",
        name: "gh",
        status: "active",
        createdAt: "2026-07-13T12:00:00Z",
        updatedAt: "2026-07-13T12:00:00Z",
      }),
    ).toMatchObject({ status: "active" });

    // Create request carries the token.
    expect(
      CredentialCreate.parse({
        key: "https://api.github.com",
        category: "static_bearer",
        token: "ghp_secret",
      }),
    ).toMatchObject({ category: "static_bearer" });

    // mcp_oauth create with a refresh block — tokenUrl MUST be an https URL (SEC-3).
    expect(
      CredentialCreate.parse({
        key: "https://mcp.example.com",
        category: "mcp_oauth",
        accessToken: "at_secret",
        refreshToken: "rt_secret",
        refresh: {
          method: "client_secret_basic",
          tokenUrl: "https://auth.example.com/oauth/token",
          clientId: "cid",
          clientSecret: "csec",
        },
      }),
    ).toMatchObject({ category: "mcp_oauth" });

    // Response must NOT carry the token.
    const resp = {
      id: "vcred_01JAZZZZZZZZZZZZZZZZZZZZZZ",
      vaultId: "vault_01JAZZZZZZZZZZZZZZZZZZZZZZ",
      key: "https://api.github.com",
      category: "static_bearer",
      status: "active",
      createdAt: "2026-07-13T12:00:00Z",
    };
    expect(Credential.parse(resp)).toEqual(resp);
  });

  it("Memory store + version", () => {
    expect(
      MemoryStoreCreate.parse({
        displayTitle: "Project conventions",
        instructions: "Follow the existing patterns…",
        access: "read_write",
        metadata: {},
      }),
    ).toMatchObject({ access: "read_write" });
    expect(
      MemoryStore.parse({
        id: "mem_01JAZZZZZZZZZZZZZZZZZZZZZZ",
        displayTitle: "Project conventions",
        access: "read_write",
        status: "active",
        mountPath: null,
        createdAt: "2026-07-13T12:00:00Z",
        updatedAt: "2026-07-13T12:00:00Z",
      }),
    ).toMatchObject({ mountPath: null });
    expect(
      MemoryVersion.parse({
        id: "memver_01JAZZZZZZZZZZZZZZZZZZZZZZ",
        memoryPath: "conventions.md",
        contentSha256: "abc123",
        redacted: false,
        createdAt: "2026-07-13T12:00:00Z",
        expiresAt: null,
      }),
    ).toMatchObject({ redacted: false });
  });

  it("File + Skill", () => {
    expect(
      File.parse({
        id: "file_01JAZZZZZZZZZZZZZZZZZZZZZZ",
        name: "out.txt",
        contentType: "text/plain",
        sizeBytes: 42,
        createdAt: "2026-07-13T12:00:00Z",
      }),
    ).toMatchObject({ sizeBytes: 42 });
    expect(
      Skill.parse({
        id: "skill_01JAZZZZZZZZZZZZZZZZZZZZZZ",
        displayTitle: "pdf",
        type: "custom",
        versions: [{ version: 1, createdAt: "2026-07-13T12:00:00Z" }],
        createdAt: "2026-07-13T12:00:00Z",
      }),
    ).toMatchObject({ type: "custom" });
  });

  it("Outcome create + resource", () => {
    expect(
      OutcomeCreate.parse({
        description: "Refactor auth.ts to use async/await",
        rubric: { type: "text", content: "## Criteria\n- All callbacks converted…" },
        maxIterations: 3,
      }),
    ).toMatchObject({ maxIterations: 3 });
    expect(
      Outcome.parse({
        id: "outc_01JAZZZZZZZZZZZZZZZZZZZZZZ",
        status: "active",
        iteration: 0,
        createdAt: "2026-07-13T12:00:00Z",
      }),
    ).toMatchObject({ iteration: 0 });
  });

  it("Job create + resource + run", () => {
    expect(
      JobCreate.parse({
        name: "nightly-test-run",
        agent: "agent_01JAZZZZZZZZZZZZZZZZZZZZZZ",
        environmentId: "env_01JAZZZZZZZZZZZZZZZZZZZZZZ",
        initialEvents: [
          { type: "user.message", content: "Pull latest and run the full E2E suite" },
        ],
        sessionConfig: { resources: [], vaultIds: ["vault_01JAZZZZZZZZZZZZZZZZZZZZZZ"] },
        schedule: { cron: "0 7 * * 1-5", tz: "America/New_York" },
        oneShot: false,
        metadata: {},
      }),
    ).toMatchObject({ oneShot: false });
    expect(
      Job.parse({
        id: "job_01JAZZZZZZZZZZZZZZZZZZZZZZ",
        name: "nightly-test-run",
        status: "active",
        agent: "agent_01JAZZZZZZZZZZZZZZZZZZZZZZ",
        environmentId: "env_01JAZZZZZZZZZZZZZZZZZZZZZZ",
        schedule: { cron: "0 7 * * 1-5", tz: "America/New_York" },
        oneShot: false,
        createdAt: "2026-07-13T12:00:00Z",
        updatedAt: "2026-07-13T12:00:00Z",
      }),
    ).toMatchObject({ status: "active" });
    expect(
      JobRun.parse({
        id: "run_01JAZZZZZZZZZZZZZZZZZZZZZZ",
        scheduledAt: "2026-07-13T07:00:00Z",
        triggeredAt: "2026-07-13T07:00:05Z",
        sessionId: "sess_01JAZZZZZZZZZZZZZZZZZZZZZZ",
        manual: false,
        createdAt: "2026-07-13T07:00:05Z",
      }),
    ).toMatchObject({ manual: false });
  });

  it("Webhook create + response + test + payload", () => {
    expect(
      WebhookCreate.parse({
        url: "https://hooks.example.com/pi-managed",
        eventTypes: ["session.status_idle", "session.status_terminated", "job.run_failed"],
      }),
    ).toMatchObject({ eventTypes: expect.arrayContaining(["session.status_idle"]) });
    expect(
      WebhookCreateResponse.parse({
        id: "wh_01JAZZZZZZZZZZZZZZZZZZZZZZ",
        url: "https://hooks.example.com/pi-managed",
        eventTypes: ["session.status_idle"],
        status: "active",
        signingSecret: "whsec_01JAZZZZZZZZZZZZZZZZZZZZZZ",
        createdAt: "2026-07-13T12:00:00Z",
        updatedAt: "2026-07-13T12:00:00Z",
      }),
    ).toMatchObject({ signingSecret: "whsec_01JAZZZZZZZZZZZZZZZZZZZZZZ" });
    // Retrieve response must NOT include signingSecret.
    expect(
      Webhook.parse({
        id: "wh_01JAZZZZZZZZZZZZZZZZZZZZZZ",
        url: "https://hooks.example.com/pi-managed",
        eventTypes: ["session.status_idle"],
        status: "active",
        createdAt: "2026-07-13T12:00:00Z",
        updatedAt: "2026-07-13T12:00:00Z",
      }),
    ).toMatchObject({ status: "active" });
    expect(
      WebhookTestResponse.parse({ delivered: true, responseCode: 200 }),
    ).toMatchObject({ delivered: true });
    expect(
      WebhookPayload.parse({
        type: "session.status_idle",
        id: "evt_01JAZZZZZZZZZZZZZZZZZZZZZZ",
        createdAt: "2026-07-13T12:00:00Z",
      }),
    ).toMatchObject({ type: "session.status_idle" });
  });

  it("Tenant + API keys (raw key write-only)", () => {
    expect(
      TenantInfo.parse({
        tenantId: "tnt_01JAZZZZZZZZZZZZZZZZZZZZZZ",
        name: "Acme Corp",
        quotaPlan: "pro",
        quotaUsage: {
          concurrentSessions: 3,
          concurrentSandboxes: 3,
          jobs: 42,
          vaultSize: 5,
          memorySize: 120000,
          fileStorage: 5368709120,
          tokenSpendUsd: 12.34,
        },
      }),
    ).toMatchObject({ quotaPlan: "pro" });
    expect(
      ApiKeyCreateResponse.parse({
        id: "apikey_01JAZZZZZZZZZZZZZZZZZZZZZZ",
        name: "ci-key",
        key: "pmb_live_secret",
        createdAt: "2026-07-13T12:00:00Z",
      }),
    ).toMatchObject({ key: "pmb_live_secret" });
    // Resource must NOT include raw key.
    expect(
      ApiKey.parse({
        id: "apikey_01JAZZZZZZZZZZZZZZZZZZZZZZ",
        name: "ci-key",
        createdAt: "2026-07-13T12:00:00Z",
      }),
    ).toMatchObject({ name: "ci-key" });
  });

  it("Cursor wrapper", () => {
    const Page = Cursor(Agent);
    const page = Page.parse({
      data: [
        {
          id: "agent_01JAZZZZZZZZZZZZZZZZZZZZZZ",
          name: "a",
          currentVersion: 1,
          status: "active",
          createdAt: "2026-07-13T12:00:00Z",
          updatedAt: "2026-07-13T12:00:00Z",
        },
      ],
      nextCursor: "eyJzIjoxMjM0NTYifQ",
    });
    expect(page.data).toHaveLength(1);
    expect(page.nextCursor).toBe("eyJzIjoxMjM0NTYifQ");
  });

  it("Error envelope round-trip", () => {
    const env = {
      error: {
        type: "request_error",
        code: "invalid_request",
        message: "Human-readable description of the failure.",
        details: { field: "name" },
        requestId: "req_01HXXXXXXXXXXXXXXX",
      },
    };
    const parsed = ErrorEnvelope.parse(env);
    expect(parsed.error.code).toBe("invalid_request");
    expect(parsed.error.requestId).toBe("req_01HXXXXXXXXXXXXXXX");
    // round-trip
    expect(ErrorEnvelope.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });
});

describe("security invariants (negative)", () => {
  it("Credential response rejects a payload containing `token`", () => {
    const leak = {
      id: "vcred_01JAZZZZZZZZZZZZZZZZZZZZZZ",
      vaultId: "vault_01JAZZZZZZZZZZZZZZZZZZZZZZ",
      key: "https://api.github.com",
      category: "static_bearer",
      status: "active",
      createdAt: "2026-07-13T12:00:00Z",
      token: "ghp_secret",
    };
    // zod objects strip unknown keys by default; verify the secret does not survive
    // parsing and is never accessible on a typed Credential.
    const parsed = Credential.parse(leak);
    expect((parsed as Record<string, unknown>).token).toBeUndefined();
    // And an explicit `.strict()`-style check: the schema must not declare `token`.
    expect("token" in Credential.shape).toBe(false);
  });

  it("Webhook retrieve rejects signingSecret in its shape", () => {
    expect("signingSecret" in Webhook.shape).toBe(false);
  });

  it("ApiKey resource rejects raw key in its shape", () => {
    expect("key" in ApiKey.shape).toBe(false);
  });

  it("tenantId is not accepted on AgentCreate", () => {
    expect("tenantId" in AgentCreate.shape).toBe(false);
  });

  it("mcp_oauth refresh.tokenUrl rejects non-https / non-URL (SEC-3)", () => {
    const base = {
      key: "https://mcp.example.com",
      category: "mcp_oauth" as const,
      accessToken: "at_secret",
      refresh: {
        method: "client_secret_basic" as const,
        clientId: "cid",
        clientSecret: "csec",
      },
    };
    // http scheme rejected — the refresh loop POSTs client creds + refresh token,
    // so the endpoint must be TLS-protected.
    expect(
      CredentialCreate.safeParse({
        ...base,
        refresh: { ...base.refresh, tokenUrl: "http://auth.example.com/token" },
      }).success,
    ).toBe(false);
    // A non-URL string is rejected.
    expect(
      CredentialCreate.safeParse({
        ...base,
        refresh: { ...base.refresh, tokenUrl: "not-a-url" },
      }).success,
    ).toBe(false);
    // A well-formed https URL passes the scheme check here; host/IP reachability
    // (SSRF) is enforced separately at connect time by the pinned transport.
    expect(
      CredentialCreate.safeParse({
        ...base,
        refresh: { ...base.refresh, tokenUrl: "https://auth.example.com/token" },
      }).success,
    ).toBe(true);
  });
});

describe("ID prefixes", () => {
  it("agentId accepts agent_ and rejects env_", () => {
    expect(agentId.safeParse("agent_01JAZZZZZZZZZZZZZZZZZZZZZZ").success).toBe(true);
    expect(agentId.safeParse("env_01JAZZZZZZZZZZZZZZZZZZZZZZ").success).toBe(false);
    expect(agentId.safeParse("agent_").success).toBe(false);
  });

  it("envId accepts env_ and rejects agent_", () => {
    expect(envId.safeParse("env_01JAZZZZZZZZZZZZZZZZZZZZZZ").success).toBe(true);
    expect(envId.safeParse("agent_01JAZZZZZZZZZZZZZZZZZZZZZZ").success).toBe(false);
  });
});
