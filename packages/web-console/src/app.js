/**
 * Pi Managed Console — read-only SPA (v1), spec §26.6.
 *
 * Dependency-free vanilla JS. The module exports {@link apiClient} (a thin,
 * testable wrapper around fetch) and a {@link bootstrap} DOM-wiring entrypoint.
 *
 * Auth: every request carries `Authorization: Bearer <apiKey>`. The key is
 * supplied at runtime by the user and stored in localStorage (read-only
 * console; warned in the UI). No credentials are hardcoded anywhere.
 *
 * Endpoints (docs/api-reference.md §"Sessions" / §"Events & SSE"):
 *   GET /v1/sessions                  — list (cursor-paginated; status filter)
 *   GET /v1/sessions/:id              — retrieve (status, usage, config)
 *   GET /v1/sessions/:id/entries      — positional log slice (tracing)
 *   GET /v1/sessions/:id/usage        — cumulative token usage + USD cost
 *
 * Read-only: this client performs NO mutating requests (no POST/PATCH/DELETE).
 */

const LS_KEY = "pi-managed-console.apiKey";
const LS_BASE = "pi-managed-console.baseUrl";

/**
 * Build a tenant-scoped API client. All methods issue GET requests with a
 * Bearer header. `fetchImpl` is injectable for tests.
 *
 * @param {{ baseUrl: string, apiKey: string, fetchImpl?: typeof fetch }} opts
 */
export function apiClient({ baseUrl, apiKey, fetchImpl = fetch }) {
  const origin = baseUrl.replace(/\/+$/, "");
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };

  /** @param {string} path @param {{ method?: string, query?: Record<string, any> }} [o] */
  async function req(path, o = {}) {
    const url = new URL(origin + path);
    if (o.query) {
      for (const [k, v] of Object.entries(o.query)) {
        if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
      }
    }
    const res = await fetchImpl(url.toString(), { method: o.method ?? "GET", headers });
    if (!res.ok) {
      let body = undefined;
      try { body = await res.json(); } catch { /* non-JSON error body */ }
      const err = new Error(`HTTP ${res.status} ${url.pathname}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  }

  return {
    /** GET /v1/sessions — list (paginated; status/agentId/environmentId filters). */
    listSessions(o = {}) {
      return req("/v1/sessions", {
        query: { limit: o.limit, cursor: o.cursor, status: o.status, agentId: o.agentId, environmentId: o.environmentId },
      });
    },
    /** GET /v1/sessions/:id — retrieve. */
    getSession(id) {
      return req(`/v1/sessions/${encodeURIComponent(id)}`);
    },
    /** GET /v1/sessions/:id/entries — positional log slice (tracing). */
    getEntries(id, o = {}) {
      return req(`/v1/sessions/${encodeURIComponent(id)}/entries`, {
        query: { from: o.from, to: o.to, limit: o.limit, cursor: o.cursor },
      });
    },
    /** GET /v1/sessions/:id/usage — cumulative token usage + USD cost. */
    getUsage(id) {
      return req(`/v1/sessions/${encodeURIComponent(id)}/usage`);
    },
  };
}

// ---------------------------------------------------------------------------
// Rendering (DOM). Only runs in a browser context; tests import apiClient alone.
// ---------------------------------------------------------------------------

function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function fmtTokens(u) {
  if (!u) return "—";
  return `${u.inputTokens ?? 0} / ${u.outputTokens ?? 0}`;
}

function statusClass(s) {
  return `status status-${s ?? "idle"}`;
}

/** Render the session list table. */
export function renderList(client, { data, nextCursor }, onPick) {
  const body = document.getElementById("sessionsBody");
  body.innerHTML = "";
  if (!data || data.length === 0) {
    const td = el("td", "No sessions.", "muted");
    td.colSpan = 7;
    body.appendChild(el("tr", "")).appendChild(td);
    return;
  }
  for (const s of data) {
    const tr = el("tr", "");
    tr.addEventListener("click", () => onPick(s.id));
    tr.appendChild(el("td", s.id));
    tr.appendChild(el("td", s.title || "(untitled)"));
    tr.appendChild(el("td", s.status, statusClass(s.status)));
    tr.appendChild(el("td", `${s.agentId}#${s.agentVersion ?? ""}`));
    tr.appendChild(el("td", s.environmentId));
    tr.appendChild(el("td", fmtTime(s.createdAt)));
    tr.appendChild(el("td", fmtTokens(s.usage)));
    body.appendChild(tr);
  }
  const next = document.getElementById("nextBtn");
  next.disabled = !nextCursor;
  next.dataset.cursor = nextCursor ?? "";
}

function fmtTime(t) {
  if (!t) return "—";
  try { return new Date(t).toISOString().replace("T", " ").replace(/\..*/, "Z"); }
  catch { return t; }
}

/** Render the session detail header + usage panel. */
export function renderDetail(session, usage) {
  document.getElementById("detailTitle").textContent = session.title || session.id;
  const meta = document.getElementById("detailMeta");
  meta.innerHTML = "";
  const rows = [
    ["ID", session.id],
    ["Status", session.status],
    ["Stop reason", session.stopReason ?? "—"],
    ["Agent", `${session.agentId}#${session.agentVersion ?? ""}`],
    ["Environment", session.environmentId],
    ["Created", fmtTime(session.createdAt)],
    ["Updated", fmtTime(session.updatedAt)],
    ["Last activity", fmtTime(session.lastActivityAt)],
    ["Forked from", session.forkedFromSessionId ?? "—"],
  ];
  for (const [k, v] of rows) {
    meta.appendChild(el("dt", k));
    meta.appendChild(el("dd", v));
  }

  const tbl = document.getElementById("usageTable");
  tbl.innerHTML = "";
  const u = usage || {};
  const fields = [
    ["inputTokens", u.inputTokens],
    ["outputTokens", u.outputTokens],
    ["cacheCreationInputTokens", u.cacheCreationInputTokens],
    ["cacheReadInputTokens", u.cacheReadInputTokens],
    ["usdCost", typeof u.usdCost === "number" ? `$${u.usdCost.toFixed(4)}` : u.usdCost],
  ];
  for (const [k, v] of fields) {
    const tr = el("tr", "");
    tr.appendChild(el("td", k, "muted"));
    tr.appendChild(el("td", String(v ?? "—")));
    tbl.appendChild(tr);
  }
}

/** Render the chronological tracing view from session entries. */
export function renderEntries(entries) {
  const list = document.getElementById("entriesList");
  list.innerHTML = "";
  if (!entries || entries.length === 0) {
    const li = el("li", "No events.", "muted");
    list.appendChild(li);
    return;
  }
  for (const ev of entries) {
    const li = el("li", "");
    const head = el("div", "");
    head.className = "ev-head";
    head.appendChild(el("span", `#${ev.seq ?? "?"}`, "ev-seq"));
    head.appendChild(el("span", ev.type, "ev-type"));
    head.appendChild(el("span", fmtTime(ev.processedAt), "ev-time"));
    li.appendChild(head);

    const body = el("div", "");
    body.className = "ev-body";

    // Tool-execution details (agent.tool_use / agent.tool_result).
    if (ev.type === "agent.tool_use" || ev.type === "agent.mcp_tool_use" || ev.type === "agent.custom_tool_use") {
      body.appendChild(fieldLine("tool", ev.tool));
      body.appendChild(jsonDetails("input", ev.input));
    } else if (ev.type === "agent.tool_result") {
      body.appendChild(fieldLine("tool", ev.tool));
      body.appendChild(textDetails("output", ev.output));
      if (ev.truncated) body.appendChild(el("div", "(truncated)", "ev-field"));
    } else if (ev.type === "session.status_idle") {
      body.appendChild(fieldLine("stopReason", ev.stopReason));
      if (ev.blockingEventIds?.length) body.appendChild(fieldLine("blockingEventIds", ev.blockingEventIds.join(", ")));
    } else if (ev.type === "session.error") {
      body.appendChild(fieldLine("mcpServerName", ev.mcpServerName));
      body.appendChild(fieldLine("retryStatus", ev.retryStatus));
    } else if (ev.content != null) {
      body.appendChild(textDetails("content", ev.content));
    } else {
      body.appendChild(jsonDetails("payload", restPayload(ev)));
    }
    li.appendChild(body);
    list.appendChild(li);
  }
}

function fieldLine(k, v) {
  const d = el("div", "");
  d.appendChild(el("span", `${k}: `, "ev-field"));
  d.appendChild(el("span", String(v ?? "—")));
  return d;
}
function textDetails(k, v) {
  const d = el("div", "");
  d.appendChild(el("span", `${k}: `, "ev-field"));
  d.appendChild(el("span", typeof v === "string" ? v : JSON.stringify(v)));
  return d;
}
function jsonDetails(k, v) {
  const d = el("details", "");
  const s = el("summary", `${k}${v == null ? " (none)" : ""}`);
  d.appendChild(s);
  if (v != null) d.appendChild(el("div", JSON.stringify(v, null, 2)));
  return d;
}
function restPayload(ev) {
  const { seq: _s, type: _t, processedAt: _p, ...rest } = ev;
  return rest;
}

// ---------------------------------------------------------------------------
// Controller: wires DOM events to apiClient calls.
// ---------------------------------------------------------------------------

export function bootstrap() {
  const $ = (id) => document.getElementById(id);

  const baseUrlEl = $("baseUrl");
  const apiKeyEl = $("apiKey");
  let client = null;
  let lastCursor = "";

  // Restore saved credentials.
  baseUrlEl.value = localStorage.getItem(LS_BASE) || "";
  apiKeyEl.value = localStorage.getItem(LS_KEY) || "";

  function showError(id, msg) {
    const n = $(id);
    n.textContent = msg;
    n.hidden = false;
  }
  function hideError(id) { $(id).hidden = true; }

  function connect() {
    const baseUrl = baseUrlEl.value.trim();
    const apiKey = apiKeyEl.value.trim();
    if (!baseUrl || !apiKey) {
      showError("listError", "Base URL and API key are required.");
      return;
    }
    localStorage.setItem(LS_BASE, baseUrl);
    localStorage.setItem(LS_KEY, apiKey);
    client = apiClient({ baseUrl, apiKey });
    loadList();
  }

  async function loadList(cursor) {
    if (!client) return;
    hideError("listError");
    const status = $("statusFilter").value || undefined;
    try {
      const res = await client.listSessions({ status, cursor, limit: 50 });
      lastCursor = res.nextCursor ?? "";
      renderList(client, res, openDetail);
    } catch (e) {
      showError("listError", `Failed to load sessions: ${e.message}`);
    }
  }

  async function openDetail(id) {
    $("listView").hidden = true;
    $("detailView").hidden = false;
    hideError("usageError");
    hideError("entriesError");
    try {
      const session = await client.getSession(id);
      let usage = null;
      try { usage = await client.getUsage(id); }
      catch (e) { showError("usageError", `Usage load failed: ${e.message}`); }
      renderDetail(session, usage);
      try {
        const entries = await client.getEntries(id, { limit: 200 });
        renderEntries(entries.data ?? []);
      } catch (e) {
        showError("entriesError", `Events load failed: ${e.message}`);
        renderEntries([]);
      }
    } catch (e) {
      showError("entriesError", `Session load failed: ${e.message}`);
    }
  }

  $("connectBtn").addEventListener("click", connect);
  $("clearBtn").addEventListener("click", () => {
    localStorage.removeItem(LS_KEY);
    localStorage.removeItem(LS_BASE);
    apiKeyEl.value = "";
    baseUrlEl.value = "";
    client = null;
  });
  $("refreshBtn").addEventListener("click", () => loadList());
  $("statusFilter").addEventListener("change", () => loadList());
  $("nextBtn").addEventListener("click", () => { if (lastCursor) loadList(lastCursor); });
  $("backBtn").addEventListener("click", () => {
    $("detailView").hidden = true;
    $("listView").hidden = false;
  });

  // Auto-connect if credentials are already stored.
  if (baseUrlEl.value && apiKeyEl.value) connect();
}

// Bootstrap only when a DOM is present (keeps the module importable in tests).
if (typeof document !== "undefined" && typeof window !== "undefined") {
  window.addEventListener("DOMContentLoaded", bootstrap);
}
