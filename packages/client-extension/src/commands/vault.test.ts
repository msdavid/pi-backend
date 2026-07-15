/**
 * WP-2.6 tests — `/remote:vault` command round-trips. Verifies the secret is
 * never echoed in local output (write-only, §12.4).
 */
import { describe, it, expect, vi } from "vitest";
import type { ManagedApiClient } from "../api-client.js";
import type { Cursor, Credential, Vault } from "@pi-managed/contracts";
import {
  runVaultList,
  runVaultCreate,
  runVaultAddCred,
  runVaultValidate,
} from "./vault.js";

function makeVault(over: Partial<Vault> = {}): Vault {
  return {
    id: "vault_1",
    name: "ci-secrets",
    status: "active",
    createdAt: "2026-07-13T12:00:00Z",
    updatedAt: "2026-07-13T12:00:00Z",
    ...over,
  };
}

function makeCred(over: Partial<Credential> = {}): Credential {
  return {
    id: "vcred_1",
    vaultId: "vault_1",
    key: "https://api.github.com",
    category: "static_bearer",
    status: "active",
    createdAt: "2026-07-13T12:00:00Z",
    ...over,
  };
}

interface Call {
  method: string;
  args: unknown[];
}

function makeClient(): { client: ManagedApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    listVaults: (q?: unknown) => {
      calls.push({ method: "listVaults", args: [q] });
      return Promise.resolve<Cursor<Vault>>({ data: [makeVault()], nextCursor: null });
    },
    createVault: (body: unknown) => {
      calls.push({ method: "createVault", args: [body] });
      return Promise.resolve(makeVault({ id: "vault_new", name: (body as { name: string }).name }));
    },
    addCredential: (vaultId: string, body: unknown) => {
      calls.push({ method: "addCredential", args: [vaultId, body] });
      const b = body as { key: string; category: Credential["category"] };
      return Promise.resolve(makeCred({ vaultId, key: b.key, category: b.category }));
    },
    validateCredential: (vaultId: string, key: string) => {
      calls.push({ method: "validateCredential", args: [vaultId, key] });
      return Promise.resolve("valid" as const);
    },
  } as unknown as ManagedApiClient;
  return { client, calls };
}

function makeDeps(client: ManagedApiClient | undefined) {
  const notifies: { msg: string; type?: string }[] = [];
  const widgets: { key: string; lines: string[] }[] = [];
  const statuses: { key: string; text: string }[] = [];
  const inputs = vi.fn();
  const select = vi.fn();
  return {
    deps: {
      ui: {
        notify: (msg: string, type?: "info" | "warning" | "error") => notifies.push({ msg, type }),
        setWidget: (key: string, lines: string[] | undefined) => lines && widgets.push({ key, lines }),
        setStatus: (key: string, text: string | undefined) => text && statuses.push({ key, text }),
        input: inputs,
        select,
      },
      createClient: () => client,
    },
    notifies,
    widgets,
    statuses,
    inputs,
    select,
  };
}

describe("/remote:vault commands (§24.5, §12)", () => {
  it("not configured → notifies and returns", async () => {
    const { deps, notifies } = makeDeps(undefined);
    await runVaultList(deps);
    expect(notifies[0]?.msg).toMatch(/not configured/);
  });

  it("list renders vault rows", async () => {
    const { client } = makeClient();
    const { deps, widgets } = makeDeps(client);
    await runVaultList(deps);
    expect(widgets[0]?.lines[1]).toContain("vault_1");
    expect(widgets[0]?.lines[1]).toContain("ci-secrets");
  });

  it("create prompts for name", async () => {
    const { client, calls } = makeClient();
    const { deps, inputs, notifies } = makeDeps(client);
    inputs.mockResolvedValueOnce("ci-secrets");
    await runVaultCreate(deps);
    expect(calls[0]?.args[0]).toMatchObject({ name: "ci-secrets" });
    expect(notifies.some((n) => n.msg.includes("vault_new"))).toBe(true);
  });

  it("add-cred forwards the secret and NEVER echoes it", async () => {
    const { client, calls } = makeClient();
    const { deps, inputs, select, notifies } = makeDeps(client);
    select.mockResolvedValueOnce("static_bearer");
    inputs
      .mockResolvedValueOnce("https://api.github.com")
      .mockResolvedValueOnce("ghp_SECRETVALUE");
    await runVaultAddCred(deps, "vault_1");
    const addCall = calls.find((c) => c.method === "addCredential");
    expect(addCall?.args[1]).toMatchObject({
      key: "https://api.github.com",
      category: "static_bearer",
      token: "ghp_SECRETVALUE",
    });
    // Secret must not appear anywhere in the local output.
    for (const n of notifies) {
      expect(n.msg).not.toContain("ghp_SECRETVALUE");
    }
  });

  it("add-cred environment_variable builds the right body", async () => {
    const { client, calls } = makeClient();
    const { deps, inputs, select } = makeDeps(client);
    select.mockResolvedValueOnce("environment_variable");
    inputs
      .mockResolvedValueOnce("GIT_TOKEN")
      .mockResolvedValueOnce("secretval");
    await runVaultAddCred(deps, "vault_1");
    const addCall = calls.find((c) => c.method === "addCredential");
    expect(addCall?.args[1]).toMatchObject({
      key: "GIT_TOKEN",
      category: "environment_variable",
      secretValue: "secretval",
    });
  });

  it("add-cred without vaultId → usage error", async () => {
    const { client, calls } = makeClient();
    const { deps, notifies } = makeDeps(client);
    await runVaultAddCred(deps, "");
    expect(calls).toHaveLength(0);
    expect(notifies[0]?.msg).toMatch(/Usage/);
  });

  it("validate returns the status", async () => {
    const { client, calls } = makeClient();
    const { deps, notifies } = makeDeps(client);
    await runVaultValidate(deps, "vault_1 https://api.github.com");
    expect(calls[0]).toMatchObject({ method: "validateCredential" });
    expect(notifies.some((n) => n.msg.includes("valid"))).toBe(true);
  });

  it("create-then-list round-trip", async () => {
    let stored: Vault[] = [];
    const client = {
      createVault: (body: unknown) => {
        const v = makeVault({ id: "vault_new", name: (body as { name: string }).name });
        stored = [v];
        return Promise.resolve(v);
      },
      listVaults: () => Promise.resolve<Cursor<Vault>>({ data: stored, nextCursor: null }),
    } as unknown as ManagedApiClient;
    const createDeps = makeDeps(client);
    createDeps.inputs.mockResolvedValueOnce("ci-secrets");
    await runVaultCreate(createDeps.deps);
    const listDeps = makeDeps(client);
    await runVaultList(listDeps.deps);
    expect(listDeps.widgets[0]?.lines[1]).toContain("vault_new");
  });
});
