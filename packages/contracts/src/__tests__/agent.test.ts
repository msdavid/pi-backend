/**
 * MCP server URL validation (SEC-2).
 *
 * `mcpServers[].url` is tenant-supplied and steers host-side egress, so the schema
 * MUST reject anything that is not a syntactically valid absolute http(s) URL —
 * closing off `file:`, `gopher:`, and other schemes before the request ever reaches
 * the pinned transport.
 */

import { describe, expect, it } from "vitest";
import { McpServer } from "../agent.js";

describe("McpServer.url schema (SEC-2)", () => {
  it.each([
    "https://mcp.example/rpc",
    "http://mcp.example:8080/rpc",
    "https://mcp.example.com",
  ])("accepts valid http(s) URL %s", (url) => {
    expect(McpServer.safeParse({ name: "s", url, type: "url" }).success).toBe(true);
  });

  it.each([
    "file:///etc/passwd",
    "gopher://internal/",
    "ftp://host/x",
    "not-a-url",
    "mcp.example/rpc", // no scheme
    "",
  ])("rejects non-http(s) or malformed URL %s", (url) => {
    expect(McpServer.safeParse({ name: "s", url, type: "url" }).success).toBe(false);
  });
});
