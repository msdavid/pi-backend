/**
 * WP-2.6 tests — vault `remote_*` tool definitions + create-then-list round-trip.
 * Verifies the secret is write-only (never present in tool output).
 */
import { describe, it, expect } from "vitest";
import { createVaultTools } from "./vault-tools.js";
import type { ManagedApiClient } from "../api-client.js";
import type { Credential, Cursor, Vault } from "@pi-managed/contracts";

interface Call {
  method: string;
  args: unknown[];
}

function makeClient(): { client: ManagedApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    listVaults: () => {
      calls.push({ method: "listVaults", args: [] });
      return Promise.resolve<Cursor<Vault>>({ data: [], nextCursor: null });
    },
    createVault: (body: unknown) => {
      calls.push({ method: "createVault", args: [body] });
      return Promise.resolve({
        id: "vault_new",
        status: "active",
        name: (body as { name: string }).name,
        createdAt: "2026-07-13T12:00:00Z",
        updatedAt: "2026-07-13T12:00:00Z",
      });
    },
    addCredential: (vaultId: string, body: unknown) => {
      calls.push({ method: "addCredential", args: [vaultId, body] });
      const b = body as { key: string; category: Credential["category"] };
      return Promise.resolve({
        id: "vcred_new",
        vaultId,
        key: b.key,
        category: b.category,
        status: "active",
        createdAt: "2026-07-13T12:00:00Z",
      });
    },
    validateCredential: (vaultId: string, key: string) => {
      calls.push({ method: "validateCredential", args: [vaultId, key] });
      return Promise.resolve("valid" as const);
    },
  } as unknown as ManagedApiClient;
  return { client, calls };
}

function makeTools() {
  const { client, calls } = makeClient();
  const tools = createVaultTools({ client: () => client });
  return { tools, calls, client };
}

describe("WP-2.6 vault tools", () => {
  it("defines 4 tools with detailed descriptions (>200 chars)", () => {
    const { tools } = makeTools();
    expect(tools).toHaveLength(4);
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "remote_vault_list",
        "remote_vault_create",
        "remote_vault_add_credential",
        "remote_vault_validate",
      ]),
    );
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(200);
    }
  });

  it("remote_vault_create returns the new vault id", async () => {
    const { tools, calls } = makeTools();
    const create = tools.find((t) => t.name === "remote_vault_create")!;
    const res = await create.execute("tc1", { name: "ci-secrets" }, undefined, undefined, undefined as unknown);
    expect(res.details).toMatchObject({ vaultId: "vault_new", status: "active" });
    expect(calls[0]?.args[0]).toMatchObject({ name: "ci-secrets" });
  });

  it("remote_vault_add_credential maps secret to the right body and never echoes it", async () => {
    const { tools, calls } = makeTools();
    const add = tools.find((t) => t.name === "remote_vault_add_credential")!;
    const res = await add.execute(
      "tc1",
      { vaultId: "vault_1", key: "https://api.github.com", category: "static_bearer", secret: "ghp_SECRET" },
      undefined,
      undefined,
      undefined as unknown,
    );
    const call = calls.find((c) => c.method === "addCredential");
    expect(call?.args[1]).toMatchObject({
      key: "https://api.github.com",
      category: "static_bearer",
      token: "ghp_SECRET",
    });
    // The secret must never appear in the tool result content or details.
    const json = JSON.stringify(res);
    expect(json).not.toContain("ghp_SECRET");
  });

  it("remote_vault_add_credential environment_variable maps secretValue", async () => {
    const { tools, calls } = makeTools();
    const add = tools.find((t) => t.name === "remote_vault_add_credential")!;
    await add.execute(
      "tc1",
      { vaultId: "vault_1", key: "GIT_TOKEN", category: "environment_variable", secret: "envsecret" },
      undefined,
      undefined,
      undefined as unknown,
    );
    const call = calls.find((c) => c.method === "addCredential");
    expect(call?.args[1]).toMatchObject({
      key: "GIT_TOKEN",
      category: "environment_variable",
      secretValue: "envsecret",
    });
  });

  it("remote_vault_add_credential mcp_oauth maps accessToken (+ optional refresh)", async () => {
    const { tools, calls } = makeTools();
    const add = tools.find((t) => t.name === "remote_vault_add_credential")!;
    await add.execute(
      "tc1",
      {
        vaultId: "vault_1",
        key: "https://mcp.example.com",
        category: "mcp_oauth",
        secret: "atoken",
        refreshToken: "rtoken",
        refresh: {
          method: "client_secret_basic",
          tokenUrl: "https://mcp.example.com/token",
          clientId: "cid",
          clientSecret: "csecret",
        },
      },
      undefined,
      undefined,
      undefined as unknown,
    );
    const call = calls.find((c) => c.method === "addCredential");
    expect(call?.args[1]).toMatchObject({
      key: "https://mcp.example.com",
      category: "mcp_oauth",
      accessToken: "atoken",
      refreshToken: "rtoken",
      refresh: {
        method: "client_secret_basic",
        tokenUrl: "https://mcp.example.com/token",
        clientId: "cid",
        clientSecret: "csecret",
      },
    });
  });

  it("remote_vault_add_credential rejects an invalid category", async () => {
    const { tools } = makeTools();
    const add = tools.find((t) => t.name === "remote_vault_add_credential")!;
    await expect(
      add.execute(
        "tc1",
        { vaultId: "vault_1", key: "k", category: "bogus", secret: "s" },
        undefined,
        undefined,
        undefined as unknown,
      ),
    ).rejects.toThrow(/Invalid category/);
  });

  it("remote_vault_validate returns the result", async () => {
    const { tools, calls } = makeTools();
    const validate = tools.find((t) => t.name === "remote_vault_validate")!;
    const res = await validate.execute(
      "tc1",
      { vaultId: "vault_1", key: "https://api.github.com" },
      undefined,
      undefined,
      undefined as unknown,
    );
    expect(res.details).toMatchObject({ key: "https://api.github.com", result: "valid" });
    expect(calls[0]).toMatchObject({ method: "validateCredential" });
  });

  it("create-then-list round-trip", async () => {
    let stored: Vault[] = [];
    const client = {
      createVault: (body: unknown) => {
        const v = {
          id: "vault_new",
          status: "active",
          name: (body as { name: string }).name,
          createdAt: "2026-07-13T12:00:00Z",
          updatedAt: "2026-07-13T12:00:00Z",
        } as unknown as Vault;
        stored = [v];
        return Promise.resolve(v);
      },
      listVaults: () => Promise.resolve<Cursor<Vault>>({ data: stored, nextCursor: null }),
    } as unknown as ManagedApiClient;
    const tools = createVaultTools({ client: () => client });
    const create = tools.find((t) => t.name === "remote_vault_create")!;
    await create.execute("tc1", { name: "ci-secrets" }, undefined, undefined, undefined as unknown);
    const list = tools.find((t) => t.name === "remote_vault_list")!;
    const res = await list.execute("tc1", {}, undefined, undefined, undefined as unknown);
    expect((res.details as { vaults: Vault[] }).vaults[0].id).toBe("vault_new");
  });

  it("throws if backend not configured", async () => {
    const tools = createVaultTools({ client: () => null });
    const list = tools.find((t) => t.name === "remote_vault_list")!;
    await expect(
      list.execute("tc1", {}, undefined, undefined, undefined as unknown),
    ).rejects.toThrow(/not configured/);
  });
});
