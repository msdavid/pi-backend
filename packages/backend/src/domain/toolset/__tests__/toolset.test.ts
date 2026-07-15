/**
 * Toolset config + materialization unit tests (WP-1.8, spec §11.1 / §22.2).
 *
 * Covers config algebra (defaultConfig applies to all; per-tool overrides;
 * everything-off; unknown tool name → 422), materialization (disabled tool absent,
 * enabled tool present), and permissionPolicy resolution (built-in default
 * `always_allow`; per-tool override `always_ask`).
 */

import { describe, expect, it } from "vitest";
import { FakeSandboxProvider } from "@pi-managed/testkit";
import { ApiError } from "../../errors.js";
import {
  BUILT_IN_TOOL_NAMES,
  DEFAULT_TOOLSET_CONFIG,
  DEFAULT_BUILTIN_PERMISSION_POLICY,
  DEFAULT_MCP_PERMISSION_POLICY,
  enableOnly,
  getPermissionPolicy,
  getMcpPermissionPolicy,
  materializeToolset,
  resolveTools,
  validateToolsetConfig,
  type ToolsetConfig,
} from "../index.js";
import type { RemoteToolFactories } from "../../session-manager/operations/tool-factory.js";

// ---------------------------------------------------------------------------
// Config algebra
// ---------------------------------------------------------------------------

describe("resolveTools — config algebra", () => {
  it("defaultConfig applies to all built-ins (everything-on)", () => {
    const resolved = resolveTools({
      defaultConfig: { enabled: true, permissionPolicy: "always_allow" },
    });
    expect(resolved.size).toBe(BUILT_IN_TOOL_NAMES.length);
    for (const [, t] of resolved) {
      expect(t.enabled).toBe(true);
      expect(t.permissionPolicy).toBe("always_allow");
    }
  });

  it("undefined config → DEFAULT_TOOLSET_CONFIG (all enabled, always_allow)", () => {
    const resolved = resolveTools(undefined);
    expect(resolved.size).toBe(BUILT_IN_TOOL_NAMES.length);
    for (const [, t] of resolved) {
      expect(t.enabled).toBe(true);
      expect(t.permissionPolicy).toBe("always_allow");
    }
  });

  it("per-tool overrides default (bash disabled while others stay on)", () => {
    const resolved = resolveTools({
      defaultConfig: { enabled: true, permissionPolicy: "always_allow" },
      configs: { bash: { enabled: false } },
    });
    expect(resolved.get("bash")!.enabled).toBe(false);
    for (const name of BUILT_IN_TOOL_NAMES) {
      if (name === "bash") continue;
      expect(resolved.get(name)!.enabled).toBe(true);
    }
  });

  it("per-tool permissionPolicy overrides default policy", () => {
    const resolved = resolveTools({
      defaultConfig: { enabled: true, permissionPolicy: "always_allow" },
      configs: { bash: { permissionPolicy: "always_ask" } },
    });
    expect(resolved.get("bash")!.permissionPolicy).toBe("always_ask");
    expect(resolved.get("read")!.permissionPolicy).toBe("always_allow");
  });

  it("everything-off pattern: only explicitly-enabled tools are on", () => {
    const cfg = enableOnly(["read", "grep"]);
    const resolved = resolveTools(cfg);
    expect(resolved.get("read")!.enabled).toBe(true);
    expect(resolved.get("grep")!.enabled).toBe(true);
    expect(resolved.get("bash")!.enabled).toBe(false);
    expect(resolved.get("write")!.enabled).toBe(false);
    expect(resolved.get("web_search")!.enabled).toBe(false);
  });

  it("enabled defaults to true when neither default nor per-tool sets it", () => {
    const resolved = resolveTools({ defaultConfig: {} });
    for (const name of BUILT_IN_TOOL_NAMES) {
      expect(resolved.get(name)!.enabled).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("validateToolsetConfig", () => {
  it("accepts known built-in tool names", () => {
    expect(() =>
      validateToolsetConfig({
        defaultConfig: { enabled: true },
        configs: { bash: { enabled: false }, read: { permissionPolicy: "always_ask" } },
      }),
    ).not.toThrow();
  });

  it("accepts an empty (or absent) configs map", () => {
    expect(() =>
      validateToolsetConfig({ defaultConfig: { enabled: true } }),
    ).not.toThrow();
  });

  it("rejects an unknown tool name with 422", () => {
    const bad: ToolsetConfig = {
      defaultConfig: { enabled: true },
      configs: { not_a_real_tool: { enabled: false } },
    };
    try {
      validateToolsetConfig(bad);
      throw new Error("expected validateToolsetConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const e = err as ApiError;
      expect(e.statusCode).toBe(422);
      expect(e.code).toBe("invalid_request");
      expect(e.message).toContain("not_a_real_tool");
    }
  });
});

// ---------------------------------------------------------------------------
// Permission policy resolution
// ---------------------------------------------------------------------------

describe("getPermissionPolicy", () => {
  it("built-in defaults to always_allow when config is absent", () => {
    expect(getPermissionPolicy(undefined, "bash")).toBe("always_allow");
  });

  it("inherits defaultConfig.permissionPolicy when no per-tool override", () => {
    const cfg: ToolsetConfig = {
      defaultConfig: { permissionPolicy: "always_ask" },
    };
    expect(getPermissionPolicy(cfg, "bash")).toBe("always_ask");
  });

  it("per-tool override wins over defaultConfig", () => {
    const cfg: ToolsetConfig = {
      defaultConfig: { permissionPolicy: "always_ask" },
      configs: { bash: { permissionPolicy: "always_allow" } },
    };
    expect(getPermissionPolicy(cfg, "bash")).toBe("always_allow");
    expect(getPermissionPolicy(cfg, "read")).toBe("always_ask");
  });

  it("MCP default is always_ask (Phase-3 forward-compat)", () => {
    expect(DEFAULT_MCP_PERMISSION_POLICY).toBe("always_ask");
    expect(getMcpPermissionPolicy(undefined, "some_mcp_tool")).toBe("always_ask");
  });

  it("DEFAULT_BUILTIN_PERMISSION_POLICY is always_allow", () => {
    expect(DEFAULT_BUILTIN_PERMISSION_POLICY).toBe("always_allow");
  });
});

// ---------------------------------------------------------------------------
// Materialization
// ---------------------------------------------------------------------------

/** Stub Pi factories: each returns a sentinel object tagged with its tool name. */
function fakeFactories(): RemoteToolFactories {
  const mk = (name: string) => () => ({ __sentinel: name });
  return {
    createBashTool: mk("bash"),
    createReadTool: mk("read"),
    createWriteTool: mk("write"),
    createEditTool: mk("edit"),
    createFindTool: mk("find"),
    createLsTool: mk("ls"),
  } as unknown as RemoteToolFactories;
}

/** Build CreateRemoteToolsOptions against a fake sandbox (no VM needed for construction). */
function makeOpts() {
  const provider = new FakeSandboxProvider();
  const handle = {
    id: "sb_test",
    name: "test-sandbox",
    labels: { tenant: "t_test", session: "s_test" },
  };
  return {
    provider,
    handle,
    cwd: "/workspace",
    factories: fakeFactories(),
  };
}

describe("materializeToolset", () => {
  it("default config → all nine built-ins present", () => {
    const out = materializeToolset(makeOpts(), DEFAULT_TOOLSET_CONFIG);
    expect(Object.keys(out.tools).sort()).toEqual([...BUILT_IN_TOOL_NAMES].sort());
    expect(out.userBashDisabled).toBe(true);
    for (const name of BUILT_IN_TOOL_NAMES) {
      expect(out.permissionPolicies[name]).toBe("always_allow");
    }
  });

  it("undefined config → default toolset (all enabled)", () => {
    const out = materializeToolset(makeOpts(), undefined);
    expect(Object.keys(out.tools).sort()).toEqual([...BUILT_IN_TOOL_NAMES].sort());
  });

  it("disabled tool is ABSENT from the constructed toolset", () => {
    const cfg: ToolsetConfig = {
      defaultConfig: { enabled: true, permissionPolicy: "always_allow" },
      configs: { bash: { enabled: false } },
    };
    const out = materializeToolset(makeOpts(), cfg);
    expect(out.tools).not.toHaveProperty("bash");
    expect(out.permissionPolicies.bash).toBeUndefined();
    // The other eight are still present.
    expect(out.tools).toHaveProperty("read");
    expect(out.tools).toHaveProperty("grep");
    expect(Object.keys(out.tools)).toHaveLength(BUILT_IN_TOOL_NAMES.length - 1);
  });

  it("everything-off + enableOnly(['read','grep']) → only read + grep present", () => {
    const out = materializeToolset(makeOpts(), enableOnly(["read", "grep"]));
    expect(Object.keys(out.tools).sort()).toEqual(["grep", "read"]);
    expect(out.permissionPolicies.read).toBe("always_allow");
    expect(out.permissionPolicies.grep).toBe("always_allow");
  });

  it("always_deny tool is ABSENT even when enabled (SEC-5, defense in depth)", () => {
    const cfg: ToolsetConfig = {
      defaultConfig: { enabled: true, permissionPolicy: "always_allow" },
      configs: { bash: { enabled: true, permissionPolicy: "always_deny" } },
    };
    const out = materializeToolset(makeOpts(), cfg);
    expect(out.tools).not.toHaveProperty("bash");
    expect(out.permissionPolicies.bash).toBeUndefined();
    // The other eight are still present and offered to the model.
    expect(out.tools).toHaveProperty("read");
    expect(Object.keys(out.tools)).toHaveLength(BUILT_IN_TOOL_NAMES.length - 1);
  });

  it("enabled tool is present and carries its per-tool permissionPolicy", () => {
    const cfg: ToolsetConfig = {
      defaultConfig: { enabled: true, permissionPolicy: "always_allow" },
      configs: { bash: { permissionPolicy: "always_ask" } },
    };
    const out = materializeToolset(makeOpts(), cfg);
    expect(out.tools).toHaveProperty("bash");
    expect(out.permissionPolicies.bash).toBe("always_ask");
    expect(out.permissionPolicies.read).toBe("always_allow");
  });

  it("exposes remote operations + userBashDisabled marker (pass-through)", () => {
    const out = materializeToolset(makeOpts(), DEFAULT_TOOLSET_CONFIG);
    expect(out.operations).toBeDefined();
    expect(out.userBashDisabled).toBe(true);
  });
});
