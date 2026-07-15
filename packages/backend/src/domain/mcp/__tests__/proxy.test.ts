/**
 * MCP credential proxy fail-closed behavior (SEC-7, §25.3).
 *
 * The proxy is the credential boundary. When a binding EXISTS for the server URL
 * but its credential cannot be resolved (absent, rotated, undecryptable, empty),
 * the proxy MUST refuse the call rather than egress the request body without the
 * operator-configured auth. When NO binding matches, the request proceeds
 * unauthenticated (the server may be public).
 */

import { describe, expect, it } from "vitest";
import { McpCredentialProxy, type McpCredentialResolver } from "../proxy.js";
import { McpAuthError } from "../client.js";
import type { SecretBinding } from "../../ports.js";

const SERVER_URL = "https://mcp.example/rpc";

/** A `static_bearer` binding matching {@link SERVER_URL}. */
function bearerBinding(): SecretBinding {
  return {
    placeholderName: "$MSB_MCP",
    category: "static_bearer",
    credentialRef: {
      tenantId: "t_1",
      vaultId: "v_1",
      credentialKey: SERVER_URL,
    },
    mcpServerUrl: SERVER_URL,
  };
}

/** A resolver that always returns `token` (or `null`). */
function resolverReturning(token: string | null): McpCredentialResolver {
  return { async resolveToken() { return token; } };
}

describe("McpCredentialProxy fail-closed (SEC-7)", () => {
  it("injects the bearer token when the binding resolves", async () => {
    const proxy = new McpCredentialProxy([bearerBinding()], resolverReturning("s3cret"));
    const auth = await proxy.authorize(SERVER_URL);
    expect(auth.injected).toBe(true);
    expect(auth.headers.Authorization).toBe("Bearer s3cret");
    expect(auth.bindingCategory).toBe("static_bearer");
  });

  it("proceeds unauthenticated when NO binding matches the server URL", async () => {
    // Resolver would throw if consulted — it must never be reached with no binding.
    const resolver: McpCredentialResolver = {
      async resolveToken() {
        throw new Error("resolver must not be called when no binding matches");
      },
    };
    const proxy = new McpCredentialProxy([], resolver);
    const auth = await proxy.authorize(SERVER_URL);
    expect(auth.injected).toBe(false);
    expect(auth.headers.Authorization).toBeUndefined();
  });

  it("fails closed (throws McpAuthError) when a binding EXISTS but resolves to null", async () => {
    const proxy = new McpCredentialProxy([bearerBinding()], resolverReturning(null));
    await expect(proxy.authorize(SERVER_URL)).rejects.toBeInstanceOf(McpAuthError);
  });

  it("does not leak the request headers unauthenticated on a resolution failure", async () => {
    const proxy = new McpCredentialProxy([bearerBinding()], resolverReturning(null));
    // The failure must be a throw — never a silent "injected: false" that would
    // let the caller egress the request body without the intended credential.
    let result: unknown;
    let threw = false;
    try {
      result = await proxy.authorize(SERVER_URL, { "X-Body": "sensitive" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(result).toBeUndefined();
  });

  it("propagates a resolver error (fail closed on undecryptable credentials)", async () => {
    const resolver: McpCredentialResolver = {
      async resolveToken() {
        throw new Error("decrypt failed");
      },
    };
    const proxy = new McpCredentialProxy([bearerBinding()], resolver);
    await expect(proxy.authorize(SERVER_URL)).rejects.toThrow("decrypt failed");
  });
});
