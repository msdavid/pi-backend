/**
 * Backend-hosted `web_fetch` / `web_search` tools (WP-1.4, spec §11.1).
 *
 * Unlike the seven file/process tools, these run **in the backend process** (not in
 * the sandbox): they need network egress the microVM may not have, and the agent
 * controls the target URL. Every request passes through the {@link safeFetch} SSRF
 * guard (no private/loopback/link-local/cloud-metadata IPs, DNS-pin to prevent
 * rebinding, redirect re-check, no internal credentials).
 *
 * The tools return a Pi-compatible `AgentToolResult` (`content: TextContent[]`).
 * Typebox parameter schemas are not constructed here — the session manager (WP-1.5)
 * wraps these execute functions with `defineTool` when registering them against the
 * real Pi runtime. Keeping the schemas local avoids a static dependency on Pi.
 */

import {
  safeFetch,
  SsrfBlockedError,
  type DnsResolver,
} from "./ssrf-guard.js";

/** A single text content block (structurally identical to Pi's `TextContent`). */
export interface TextContent {
  type: "text";
  text: string;
}

/** Pi-compatible tool result (structurally identical to `AgentToolResult<unknown>`). */
export interface ToolResult {
  content: TextContent[];
  details?: unknown;
  terminate?: boolean;
}

/** Injectable search backend for `web_search`. */
export interface SearchProvider {
  search(query: string): Promise<SearchResult[]>;
}

/** One search hit. */
export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

/** Options for {@link createWebTools}. */
export interface WebToolsOptions {
  /** Search backend for `web_search`. If absent, the tool reports it is unconfigured. */
  searchProvider?: SearchProvider;
  /** Injectable DNS resolver (tests). */
  resolver?: DnsResolver;
  /** Max response bytes read before truncation. */
  maxBytes?: number;
}

/** A minimal tool shape the session manager adapts to Pi's `AgentTool`. */
export interface BackendTool {
  name: string;
  description: string;
  execute: (params: Record<string, unknown>) => Promise<ToolResult>;
}

const DEFAULT_MAX_BYTES = 1_000_000;

/**
 * Build the two backend-hosted web tools. Both are SSRF-guarded; neither touches the
 * sandbox or the host filesystem (beyond the fetch itself).
 */
export function createWebTools(opts: WebToolsOptions = {}): {
  web_fetch: BackendTool;
  web_search: BackendTool;
} {
  const resolver = opts.resolver;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  const web_fetch: BackendTool = {
    name: "web_fetch",
    description:
      "Fetch a URL and return its text content. SSRF-guarded: private/loopback/" +
      "link-local/cloud-metadata IPs are denied; redirects are re-checked per hop.",
    execute: async (params) => {
      const url = String(params.url ?? "");
      if (!url) {
        return textResult("web_fetch requires a `url` parameter.");
      }
      try {
        const { response, finalUrl } = await safeFetch(
          url,
          { method: "GET" },
          resolver,
        );
        const contentType = response.headers.get("content-type") ?? "";
        const body = await readBoundedText(response, maxBytes);
        const summary =
          `${response.status} ${response.statusText} ${contentType}\n` +
          `final-url: ${finalUrl}\n\n`;
        return textResult(summary + body);
      } catch (e) {
        if (e instanceof SsrfBlockedError) {
          return textResult(`web_fetch blocked (${e.reason}): ${e.message}`);
        }
        return textResult(`web_fetch error: ${(e as Error).message}`);
      }
    },
  };

  const web_search: BackendTool = {
    name: "web_search",
    description:
      "Search the web and return results. The query is sent to the configured " +
      "search backend; result URLs may be fetched (SSRF-guarded) for snippets.",
    execute: async (params) => {
      const query = String(params.query ?? "");
      if (!query) {
        return textResult("web_search requires a `query` parameter.");
      }
      if (!opts.searchProvider) {
        return textResult(
          "web_search is not configured (no search provider). " +
            "Provide a `SearchProvider` to `createWebTools`.",
        );
      }
      let results: SearchResult[];
      try {
        results = await opts.searchProvider.search(query);
      } catch (e) {
        return textResult(`web_search error: ${(e as Error).message}`);
      }
      const lines = results.map(
        (r, i) =>
          `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`,
      );
      return textResult(
        results.length === 0
          ? `No results for: ${query}`
          : `Results for: ${query}\n\n${lines.join("\n\n")}`,
      );
    },
  };

  return { web_fetch, web_search };
}

/** Read up to `maxBytes` of a response body as UTF-8 text (truncates with a notice). */
async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      if (total + value.length > maxBytes) {
        chunks.push(value.slice(0, maxBytes - total));
        truncated = true;
        total = maxBytes;
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(
    Buffer.concat(chunks),
  );
  return truncated ? `${text}\n\n[response truncated at ${maxBytes} bytes]` : text;
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}
