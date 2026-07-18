/**
 * Tree tab (WP-C2.3; console-spec §7.3, W2 step 4: "the JSONL fork
 * structure"). Two lenses over how a session branched:
 *
 * - **Fork lineage** — the session-level fork relationships, derived from
 *   `forkedFromSessionId` on the session resources (§7.6: every node is a
 *   SessionId deep link; the viewed session is highlighted). Ancestors are
 *   walked one detail read per level (cache-shared with their own detail
 *   pages); children come from the sessions-list pages already in the cache
 *   (the API has no `forkedFrom` list filter yet, so only sessions in the
 *   fetched pages are scanned — a bounded view, not a guarantee).
 * - **Log tree** — `GET /v1/sessions/:id/tree` (branches + fork points).
 *   Contracts pins `SessionTree = z.unknown()` (clients must not depend on
 *   internal structure), so the current `{root, branches:[{id, parentId,
 *   type}]}` shape is rendered best-effort and anything else falls back to
 *   the raw JSON viewer.
 */
import type { ReactNode } from "react";
import type { Session } from "@pi-managed/contracts";

import {
  useSession,
  useSessions,
  useSessionTree,
} from "../../api/sessions.js";
import { Button } from "../../ui/button.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { JsonViewer } from "../../ui/json-viewer.js";
import { SessionId } from "./session-id.js";
import styles from "./tree-tab.module.css";

/** Guard against a corrupt `forkedFromSessionId` cycle in the walked chain. */
const MAX_ANCESTOR_DEPTH = 20;

export function TreeTab({ session }: { session: Session }) {
  return (
    <div>
      <h2 className={styles.heading}>Fork lineage</h2>
      <ForkLineage session={session} />
      <h2 className={styles.heading}>Log tree</h2>
      <LogTree sessionId={session.id} />
    </div>
  );
}

// --- Fork lineage (session resources) ---------------------------------------

function ForkLineage({ session }: { session: Session }) {
  // Children scan: reuses the sessions-list cache (first page unless the
  // list screen already fetched more) — see the module docstring caveat.
  const list = useSessions({});
  const children = (list.data?.pages ?? [])
    .flatMap((page) => page.data)
    .filter((s) => s.forkedFromSessionId === session.id);

  const current = (
    <li className={styles.currentNode}>
      <span className={styles.node} aria-current="true">
        <SessionId id={session.id} maxLength={30} />
        <span className={styles.nodeTag}>this session</span>
        {session.title ? (
          <span className={styles.nodeTitle}>{session.title}</span>
        ) : null}
      </span>
      {children.length > 0 ? (
        <ul className={styles.branch}>
          {children.map((child) => (
            <li key={child.id}>
              <span className={styles.node}>
                <SessionId id={child.id} maxLength={30} />
                {child.title ? (
                  <span className={styles.nodeTitle}>{child.title}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );

  return (
    <>
      {!session.forkedFromSessionId && children.length === 0 ? (
        <p className={styles.note}>
          Not forked from any session, and no forks of it{" "}
          {list.isFetched ? "found among the listed sessions" : "loaded yet"}.
        </p>
      ) : null}
      <ul className={styles.lineage} aria-label="Fork lineage">
        {session.forkedFromSessionId ? (
          <AncestorNode
            id={session.forkedFromSessionId}
            depth={MAX_ANCESTOR_DEPTH}
          >
            {current}
          </AncestorNode>
        ) : (
          current
        )}
      </ul>
    </>
  );
}

/**
 * One ancestor level: renders `children` (the chain below) nested under this
 * session's node, and recurses upward while a `forkedFromSessionId` exists.
 */
function AncestorNode({
  id,
  depth,
  children,
}: {
  id: string;
  depth: number;
  children: ReactNode;
}) {
  const ancestor = useSession(id);
  const item = (
    <li>
      <span className={styles.node}>
        <SessionId id={id} maxLength={30} />
        {ancestor.data?.title ? (
          <span className={styles.nodeTitle}>{ancestor.data.title}</span>
        ) : null}
      </span>
      <ul className={styles.branch}>{children}</ul>
    </li>
  );
  const parentId = ancestor.data?.forkedFromSessionId;
  if (parentId && depth > 0) {
    return (
      <AncestorNode id={parentId} depth={depth - 1}>
        {item}
      </AncestorNode>
    );
  }
  return item;
}

// --- Log tree (GET /v1/sessions/:id/tree) -----------------------------------

interface JsonlTreeNode {
  id: string | null;
  parentId: string | null;
  type: string | null;
}

interface JsonlTree {
  root: string | null;
  branches: JsonlTreeNode[];
}

/** Best-effort structural read of the (officially opaque) tree response. */
function parseJsonlTree(value: unknown): JsonlTree | null {
  if (value === null || typeof value !== "object") return null;
  const { root, branches } = value as { root?: unknown; branches?: unknown };
  if (root !== null && typeof root !== "string") return null;
  if (!Array.isArray(branches)) return null;
  const nodes: JsonlTreeNode[] = [];
  for (const raw of branches) {
    if (raw === null || typeof raw !== "object") return null;
    const { id, parentId, type } = raw as {
      id?: unknown;
      parentId?: unknown;
      type?: unknown;
    };
    if (id !== null && typeof id !== "string") return null;
    if (parentId !== null && typeof parentId !== "string") return null;
    if (type !== null && typeof type !== "string") return null;
    nodes.push({ id: id ?? null, parentId: parentId ?? null, type: type ?? null });
  }
  return { root: root ?? null, branches: nodes };
}

/** Depth of every node via its `parentId` chain (cycle-safe). */
function depthsOf(nodes: JsonlTreeNode[]): Map<JsonlTreeNode, number> {
  const byId = new Map<string, JsonlTreeNode>();
  for (const node of nodes) {
    if (node.id !== null && !byId.has(node.id)) byId.set(node.id, node);
  }
  const depths = new Map<JsonlTreeNode, number>();
  for (const node of nodes) {
    let depth = 0;
    const seen = new Set<JsonlTreeNode>([node]);
    let parent = node.parentId !== null ? byId.get(node.parentId) : undefined;
    while (parent && !seen.has(parent)) {
      depth += 1;
      seen.add(parent);
      parent = parent.parentId !== null ? byId.get(parent.parentId) : undefined;
    }
    depths.set(node, depth);
  }
  return depths;
}

function LogTree({ sessionId }: { sessionId: string }) {
  const tree = useSessionTree(sessionId);

  if (tree.isError) {
    return (
      <div>
        <ErrorAlert label="tree" error={tree.error} />
        <Button onClick={() => void tree.refetch()}>Retry</Button>
      </div>
    );
  }
  if (tree.isPending) {
    return <p role="status">Loading tree…</p>;
  }

  const parsed = parseJsonlTree(tree.data);
  if (!parsed) {
    // A shape this renderer does not know — show it rather than hide it.
    return <JsonViewer label="tree" value={tree.data} />;
  }
  if (parsed.branches.length === 0) {
    return (
      <p className={styles.note}>
        No log entries yet — the tree appears once the session has done work.
      </p>
    );
  }

  // A fork point is an entry more than one entry descends from.
  const childCounts = new Map<string, number>();
  for (const node of parsed.branches) {
    if (node.parentId !== null) {
      childCounts.set(node.parentId, (childCounts.get(node.parentId) ?? 0) + 1);
    }
  }
  const depths = depthsOf(parsed.branches);

  return (
    <ol className={styles.logTree} aria-label="Log tree">
      {parsed.branches.map((node, i) => (
        <li
          key={node.id ?? `#${i}`}
          className={styles.logNode}
          style={{ paddingInlineStart: `${depths.get(node) ?? 0}rem` }}
        >
          <span className={styles.logType}>{node.type ?? "(unknown)"}</span>
          {node.id ? <code className={styles.logId}>{node.id}</code> : null}
          {(childCounts.get(node.id ?? "") ?? 0) > 1 ? (
            <span className={styles.forkPoint}>
              fork point ×{childCounts.get(node.id ?? "")}
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
