/**
 * Conversation tab feature tests (WP-C4.1; console-spec §10.1, `console.md`
 * §5a, journey W5 steps 1–2). The conversation-shaped lens over
 * `GET /v1/sessions/:id/messages`: user messages distinct/right-aligned,
 * assistant text as pre-wrap paragraphs with fenced code monospaced, tool
 * call / tool result / thinking compact with the payload one `JsonViewer`
 * click away, the teaching empty state, the tail cap for long transcripts,
 * the forked-seed boundary microcopy, and the stream-driven refetch on a
 * `session.status_*` frame. The API client is a collaborator (fake at the
 * `<ApiClientProvider>` seam).
 */
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { FakeConsoleApi } from "../../test/fake-console-api.js";
import { renderConsole } from "../../test/render-console.js";
import { axe } from "../../ui/test-utils.js";

const SESSION = "sess_01CONV";

beforeEach(() => {
  window.localStorage.clear();
});

/** An idle session with one full turn's messages (Pi `AgentMessage` shapes). */
function fakeWithConversation(): FakeConsoleApi {
  const api = FakeConsoleApi.signedIn(["read"]);
  api.addSession({ id: SESSION, status: "idle" });
  api.messages.set(SESSION, [
    { role: "user", content: "Fix the login bug" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "auth.ts looks off" },
        {
          type: "toolCall",
          id: "tc_1",
          name: "bash",
          arguments: { command: "grep -n token auth.ts" },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "tc_1",
      toolName: "bash",
      content: [{ type: "text", text: "42: expiresAt" }],
    },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Found it — patch:\n```ts\nconst ok = true;\n```\nDeploying now.",
        },
      ],
    },
  ]);
  return api;
}

async function renderConversation(api: FakeConsoleApi, id = SESSION) {
  const result = renderConsole(api, `/console/sessions/${id}`);
  await screen.findByRole("tablist", { name: "Session detail" });
  await userEvent
    .setup()
    .click(screen.getByRole("tab", { name: "Conversation" }));
  return result;
}

describe("conversation rendering (§10.1 — a lens, not the Trace)", () => {
  it("renders user and assistant messages with role labels, in order", async () => {
    await renderConversation(fakeWithConversation());
    const list = await screen.findByRole("list", { name: "Conversation" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(4);

    expect(items[0]).toHaveTextContent("you");
    expect(items[0]).toHaveTextContent("Fix the login bug");
    expect(items[1]).toHaveTextContent("agent");
    expect(items[3]).toHaveTextContent("Found it — patch:");
  });

  it("string content splits ``` fences into monospaced code blocks", async () => {
    await renderConversation(fakeWithConversation());
    const list = await screen.findByRole("list", { name: "Conversation" });
    const code = within(list).getByText("const ok = true;");
    expect(code.closest("pre")).not.toBeNull();
    // The language tag line is not part of the rendered code.
    expect(code).not.toHaveTextContent("ts");
    expect(within(list).getByText("Deploying now.")).toBeInTheDocument();
  });

  it("tool call / tool result / thinking are compact, payload one click away (DP-2)", async () => {
    await renderConversation(fakeWithConversation());
    const list = await screen.findByRole("list", { name: "Conversation" });

    // Compact summaries — internals NOT in the DOM while collapsed.
    expect(within(list).getByText("tool call — bash")).toBeInTheDocument();
    expect(within(list).getByText("tool result — bash")).toBeInTheDocument();
    expect(screen.queryByText(/grep -n token/)).not.toBeInTheDocument();

    // One click expands the full block.
    await userEvent
      .setup()
      .click(within(list).getByRole("button", { name: /call/ }));
    expect(await screen.findByText(/grep -n token/)).toBeInTheDocument();

    // Thinking is de-emphasized behind the same affordance.
    expect(
      within(list).getByRole("button", { name: /thinking/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/auth\.ts looks off/)).not.toBeInTheDocument();
  });

  it("a message shape it does not recognize still renders (raw JSON fallback)", async () => {
    const api = fakeWithConversation();
    api.messages.set(SESSION, [{ role: "user", content: "hi" }, "bare-string"]);
    await renderConversation(api);
    const list = await screen.findByRole("list", { name: "Conversation" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(
      within(list).getByRole("button", { name: /message/ }),
    ).toBeInTheDocument();
  });
});

describe("empty and edge states", () => {
  it("no messages → the teaching empty state with the CLI path (DP-5)", async () => {
    const api = FakeConsoleApi.signedIn(["read"]);
    api.addSession({ id: SESSION, status: "idle" });
    await renderConversation(api);
    expect(await screen.findByText("No conversation yet")).toBeInTheDocument();
    expect(screen.getByText(`/remote:resume ${SESSION}`)).toBeInTheDocument();
  });

  it("long transcripts start at the tail with a show-all control", async () => {
    const api = FakeConsoleApi.signedIn(["read"]);
    api.addSession({ id: SESSION, status: "idle" });
    api.messages.set(
      SESSION,
      Array.from({ length: 105 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `message ${i}`,
      })),
    );
    await renderConversation(api);
    const list = await screen.findByRole("list", { name: "Conversation" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(100);
    // The tail, not the head: the first 5 are elided.
    expect(screen.queryByText("message 0")).not.toBeInTheDocument();
    expect(within(list).getByText("message 104")).toBeInTheDocument();

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Show all 105 messages" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(105);
    expect(within(list).getByText("message 0")).toBeInTheDocument();
  });

  it("a fork states the shared-seed boundary in place (DP-6)", async () => {
    const api = FakeConsoleApi.signedIn(["read"]);
    api.addSession({
      id: SESSION,
      status: "idle",
      forkedFromSessionId: "sess_01PARENT",
    });
    api.messages.set(SESSION, [{ role: "user", content: "inherited" }]);
    await renderConversation(api);
    expect(
      await screen.findByText(/history shared up to the fork point/),
    ).toBeInTheDocument();
  });
});

describe("live updates (§8.2 cache discipline — stream owned by the page)", () => {
  it("a running session says so, and a status frame refetches the messages", async () => {
    const api = fakeWithConversation();
    api.sessions[0]!.status = "running";
    await renderConversation(api);
    await screen.findByRole("list", { name: "Conversation" });
    expect(
      screen.getByText(/Turn in progress — the conversation catches up/),
    ).toBeInTheDocument();

    // The detail page owns the ONE stream (§8.2) — wait for it to attach.
    await waitFor(() =>
      expect(
        api.calls.some(
          (c) =>
            c.method === "STREAM" &&
            c.path === `/v1/sessions/${SESSION}/stream`,
        ),
      ).toBe(true),
    );

    const messagesGets = () =>
      api.calls.filter((c) => c.path === `/v1/sessions/${SESSION}/messages`)
        .length;
    const before = messagesGets();
    api.messages.get(SESSION)!.push({ role: "assistant", content: "Done." });
    act(() => {
      api.emitStream(SESSION, {
        id: 5,
        event: "session.status_idle",
        data: {
          type: "session.status_idle",
          processedAt: "2026-07-02T10:00:09.000Z",
          stopReason: "completed",
        },
      });
    });

    await waitFor(() => expect(messagesGets()).toBeGreaterThan(before));
    expect(await screen.findByText("Done.")).toBeInTheDocument();
  });
});

describe("accessibility", () => {
  it("is axe-clean", async () => {
    const { view } = await renderConversation(fakeWithConversation());
    await screen.findByRole("list", { name: "Conversation" });
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
