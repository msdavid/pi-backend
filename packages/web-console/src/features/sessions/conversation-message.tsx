/**
 * One conversation message (WP-C4.1; console-spec §10.1, `console.md` §5a).
 * The wire pins messages as `unknown` (contracts `SessionMessages`), so
 * rendering narrows structurally against Pi's `AgentMessage` slice (the
 * backend's `SessionMessageLike`: `role` user/assistant/toolResult +
 * `content` string-or-blocks) with a raw-JSON fallback — same stance as the
 * Tree tab.
 *
 * The conversation lens de-emphasizes tool internals (`console.md` §5a):
 * tool calls / tool results / thinking render as one compact line with the
 * full payload one `JsonViewer` click away (DP-2). Text renders as pre-wrap
 * paragraphs with fenced ``` blocks monospaced — markdown-ish plaintext, no
 * new dependencies.
 */
import { JsonViewer } from "../../ui/json-viewer.js";
import styles from "./conversation.module.css";

/** Structural slice of a Pi `AgentMessage` (backend `SessionMessageLike`). */
interface MessageLike {
  role: string;
  content?: unknown;
  toolName?: unknown;
  isError?: unknown;
}

/** Narrow one wire message to the {@link MessageLike} slice, or `null`. */
function asMessage(value: unknown): MessageLike | null {
  if (value === null || typeof value !== "object") return null;
  const role = (value as { role?: unknown }).role;
  return typeof role === "string" ? (value as MessageLike) : null;
}

export function ConversationMessage({ value }: { value: unknown }) {
  const message = asMessage(value);
  // A shape we don't recognize still shows up — raw, never dropped.
  if (!message) {
    return (
      <li className={styles.message}>
        <JsonViewer label="message" value={value} />
      </li>
    );
  }
  if (message.role === "user") {
    return (
      <li className={`${styles.message} ${styles.user}`}>
        <span className={styles.role}>you</span>
        <div className={styles.bubble}>
          <MessageContent content={message.content} />
        </div>
      </li>
    );
  }
  if (message.role === "assistant") {
    return (
      <li className={styles.message}>
        <span className={styles.role}>agent</span>
        <div className={styles.body}>
          <MessageContent content={message.content} />
        </div>
      </li>
    );
  }
  if (message.role === "toolResult") {
    const tool =
      typeof message.toolName === "string" ? message.toolName : "tool";
    return (
      <li className={`${styles.message} ${styles.toolLine}`}>
        <span className={styles.toolSummary}>
          tool result — {tool}
          {message.isError === true ? (
            <span className={styles.toolError}> (error)</span>
          ) : null}
        </span>
        <JsonViewer label="result" value={value} />
      </li>
    );
  }
  // An unknown role (Pi may grow the union): raw fallback, labeled with it.
  return (
    <li className={styles.message}>
      <JsonViewer label={message.role} value={value} />
    </li>
  );
}

/** `content` is a string or an array of content blocks; anything else raw. */
function MessageContent({ content }: { content: unknown }) {
  if (typeof content === "string") return <TextBlocks text={content} />;
  if (Array.isArray(content)) {
    return (
      <>
        {content.map((block, i) => (
          <ContentBlock key={i} block={block} />
        ))}
      </>
    );
  }
  if (content === undefined || content === null) return null;
  return <JsonViewer label="content" value={content} />;
}

function ContentBlock({ block }: { block: unknown }) {
  if (typeof block === "string") return <TextBlocks text={block} />;
  if (block === null || typeof block !== "object") {
    return <JsonViewer label="block" value={block} />;
  }
  const b = block as { type?: unknown; text?: unknown; name?: unknown };
  if (b.type === "text" && typeof b.text === "string") {
    return <TextBlocks text={b.text} />;
  }
  if (b.type === "thinking") {
    // De-emphasized: thinking is internal narration, one click away.
    return <JsonViewer label="thinking" value={block} />;
  }
  if (b.type === "toolCall" || b.type === "tool_use") {
    const name = typeof b.name === "string" ? b.name : "tool";
    return (
      <div className={styles.toolLine}>
        <span className={styles.toolSummary}>tool call — {name}</span>
        <JsonViewer label="call" value={block} />
      </div>
    );
  }
  return <JsonViewer label={typeof b.type === "string" ? b.type : "block"} value={block} />;
}

/**
 * Markdown-ish plaintext (§10.1, no new deps): pre-wrap paragraphs, with
 * fenced ``` blocks rendered monospaced. Odd segments of a ``` split are
 * inside a fence; a leading language tag line is dropped from the code.
 */
function TextBlocks({ text }: { text: string }) {
  const segments = text.split("```");
  return (
    <>
      {segments.map((segment, i) => {
        if (i % 2 === 1) {
          const body = segment.replace(/^[^\n]*\n/, "").replace(/\n$/, "");
          return (
            <pre key={i} className={styles.code}>
              <code>{body}</code>
            </pre>
          );
        }
        const trimmed = segment.trim();
        if (!trimmed) return null;
        return (
          <p key={i} className={styles.text}>
            {trimmed}
          </p>
        );
      })}
    </>
  );
}
