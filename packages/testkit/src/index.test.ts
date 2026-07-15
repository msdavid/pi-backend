import { describe, it, expect } from "vitest";
import {
  createTestKit,
  FakeObjectStore,
  FakeSandboxProvider,
  FakeSessionRuntime,
  TESTKIT_VERSION,
} from "./index.js";

describe("testkit scaffold", () => {
  it("exports a version constant", () => {
    expect(TESTKIT_VERSION).toBe("0.0.0");
  });
});

describe("createTestKit", () => {
  it("returns wired-together fakes for every port", () => {
    const kit = createTestKit();
    expect(kit.sandbox).toBeInstanceOf(FakeSandboxProvider);
    expect(kit.session).toBeInstanceOf(FakeSessionRuntime);
    expect(kit.objects).toBeInstanceOf(FakeObjectStore);
    expect(kit.secrets).toBeTruthy();
    expect(kit.usage).toBeTruthy();
    expect(kit.clock).toBeTruthy();
    expect(kit.scheduler).toBeTruthy();
    expect(kit.webhooks).toBeTruthy();
  });

  it("returns a fresh bundle each call (no shared state)", () => {
    const a = createTestKit();
    const b = createTestKit();
    expect(a.sandbox).not.toBe(b.sandbox);
    expect(a.objects).not.toBe(b.objects);
  });
});

describe("§25.5 invariant — no raw secret values cross the seam", () => {
  it("FakeSandboxProvider.provision accepts only placeholder refs, never values", async () => {
    const sandbox = new FakeSandboxProvider();
    const handle = await sandbox.provision({
      name: "t-tenantA-s-sess1",
      image: "ubuntu:22.04",
      cpus: 2,
      memoryMiB: 1024,
      labels: { tenant: "tenantA", session: "sess1" },
      detached: true,
      secretBindings: [
        {
          placeholderName: "$MSB_GIT_TOKEN",
          category: "environment_variable",
          credentialRef: {
            tenantId: "tenantA",
            vaultId: "vault_1",
            credentialKey: "GIT_TOKEN",
          },
        },
      ],
    });
    // The recorded binding carries only the ref — no value field exists on SecretBinding.
    const bindings = sandbox.registeredBindings.get(handle.id);
    expect(bindings).toHaveLength(1);
    expect(bindings![0].placeholderName).toBe("$MSB_GIT_TOKEN");
    expect(bindings![0]).not.toHaveProperty("value");
    expect(JSON.stringify(bindings![0])).not.toContain("supersecret");
  });

  it("FakeSecretStore.resolveBindingsForSession returns only opaque refs", async () => {
    const { secrets } = createTestKit();
    const sessionId = "sess_1";
    secrets.scriptForSession(sessionId, [
      {
        placeholderName: "$MSB_API_KEY",
        category: "environment_variable",
        credentialRef: {
          tenantId: "tenantA",
          vaultId: "vault_1",
          credentialKey: "API_KEY",
        },
      },
    ]);
    const bindings = await secrets.resolveBindingsForSession({
      tenantId: "tenantA",
      sessionId,
      vaultIds: ["vault_1"],
    });
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).not.toHaveProperty("value");
    // No secret value is reachable through the store.
    expect(JSON.stringify(secrets)).not.toContain("raw-token-value");
  });
});

describe("FakeSandboxProvider lifecycle", () => {
  it("provisions, stops/starts, and reattaches by labels", async () => {
    const sandbox = new FakeSandboxProvider();
    const handle = await sandbox.provision({
      name: "t-tenantA-s-sess1",
      image: "ubuntu:22.04",
      cpus: 1,
      memoryMiB: 512,
      labels: { tenant: "tenantA", session: "sess1" },
      detached: true,
    });
    expect(await sandbox.status(handle)).toBe("running");
    await sandbox.stop(handle);
    expect(await sandbox.status(handle)).toBe("stopped");
    await sandbox.start(handle);
    expect(await sandbox.status(handle)).toBe("running");
    const reattached = await sandbox.reattachByLabels({
      tenant: "tenantA",
      session: "sess1",
    });
    expect(reattached.map((h) => h.id)).toContain(handle.id);
  });

  it("supports crash simulation via setNextStatus", async () => {
    const sandbox = new FakeSandboxProvider();
    sandbox.setNextStatus("crashed");
    const handle = await sandbox.provision({
      name: "crashy",
      image: "ubuntu:22.04",
      cpus: 1,
      memoryMiB: 512,
      labels: { tenant: "tenantA", session: "sess1" },
      detached: true,
    });
    expect(await sandbox.status(handle)).toBe("crashed");
  });

  it("scripts exec results", async () => {
    const sandbox = new FakeSandboxProvider();
    sandbox.scriptExec("scripted", [
      { stdout: "hello", exitCode: 0 },
      { stdout: "", stderr: "boom", exitCode: 1 },
    ]);
    const handle = await sandbox.provision({
      name: "scripted",
      image: "ubuntu:22.04",
      cpus: 1,
      memoryMiB: 512,
      labels: { tenant: "t", session: "s" },
      detached: true,
    });
    const r1 = await sandbox.exec(handle, { cmd: "echo hi" });
    expect(r1.stdout).toBe("hello");
    const r2 = await sandbox.exec(handle, { cmd: "false" });
    expect(r2.exitCode).toBe(1);
    expect(r2.stderr).toBe("boom");
  });
});

describe("FakeSessionRuntime", () => {
  it("records inbound events and transitions on user.message", async () => {
    const session = new FakeSessionRuntime();
    await session.wake("sess_1");
    expect(session.status()).toBe("idle");
    await session.sendEvent({
      type: "user.message",
      id: "e1",
      createdAt: new Date().toISOString(),
      payload: { text: "hi" },
    });
    expect(session.status()).toBe("running");
    expect(session.inboundEvents).toHaveLength(1);
    await session.interrupt();
    expect(session.status()).toBe("idle");
    expect(session.interruptCount).toBe(1);
  });

  it("returns seeded entries as a positional slice", async () => {
    const session = new FakeSessionRuntime();
    session.seedEntries(
      [0, 1, 2, 3, 4].map((i) => ({
        position: i,
        type: "agent.message",
        id: `e${i}`,
        createdAt: new Date().toISOString(),
        payload: {},
      })),
    );
    const slice = await session.getEntries({ start: 1, end: 4 });
    expect(slice.map((e) => e.position)).toEqual([1, 2, 3]);
    const limited = await session.getEntries({ limit: 2 });
    expect(limited).toHaveLength(2);
  });
});

describe("FakeObjectStore", () => {
  it("round-trips a stream and lists by prefix", async () => {
    const store = new FakeObjectStore();
    const data = new TextEncoder().encode("hello world");
    await store.put("a/b/c.json", streamOf(data));
    const got = await store.get("a/b/c.json");
    const bytes = await new Response(got).arrayBuffer();
    expect(new TextDecoder().decode(bytes)).toBe("hello world");
    const metas = [];
    for await (const m of store.list("a/")) metas.push(m.key);
    expect(metas).toEqual(["a/b/c.json"]);
  });

  it("conditionalPut fails on etag mismatch", async () => {
    const store = new FakeObjectStore();
    const data = new TextEncoder().encode("v1");
    const put = await store.put("k", streamOf(data));
    await expect(
      store.conditionalPut("k", streamOf(new TextEncoder().encode("v2")), "wrong"),
    ).rejects.toThrow(/etag mismatch/);
    // With the correct etag it succeeds.
    await expect(
      store.conditionalPut("k", streamOf(new TextEncoder().encode("v2")), put.etag!),
    ).resolves.toBeTruthy();
  });
});

describe("FakeUsageRecorder", () => {
  it("records tokens and accumulates cumulatively", async () => {
    const { usage } = createTestKit();
    usage.setPrice("claude-x", { inputPerMillion: 3, outputPerMillion: 15 });
    await usage.record("sess_1", "claude-x", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
    const cum = await usage.cumulativeForSession("sess_1");
    expect(cum.inputTokens).toBe(1_000_000);
    expect(cum.totalTokens).toBe(2_000_000);
    // 3 USD input + 15 USD output = 18.
    expect(cum.usd).toBeCloseTo(18, 5);
  });

  it("checkBudget reports breach when scripted", async () => {
    const { usage } = createTestKit();
    usage.setBudgetBreached("sess_1");
    const check = await usage.checkBudget("sess_1", { maxUsd: 1 });
    expect(check.exceeded).toBe(true);
    expect(check.reason).toBe("budget_exhausted");
  });
});

describe("FakeClock + FakeScheduler", () => {
  it("advances and ticks", async () => {
    const { clock, scheduler } = createTestKit();
    const t0 = clock.now().getTime();
    clock.advance(60_000);
    expect(clock.now().getTime() - t0).toBe(60_000);

    let fired = 0;
    scheduler.onTickRun(async () => {
      fired += 1;
    });
    scheduler.setDue(true);
    await scheduler.tick();
    expect(fired).toBe(1);
  });
});

describe("FakeWebhookSink", () => {
  it("records dispatched thin payloads", async () => {
    const { webhooks } = createTestKit();
    await webhooks.dispatch({
      type: "session.status_idle",
      id: "evt_1",
      createdAt: new Date().toISOString(),
    });
    expect(webhooks.dispatched.map((e) => e.type)).toEqual([
      "session.status_idle",
    ]);
  });
});

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Response(bytes).body as ReadableStream<Uint8Array>;
}
