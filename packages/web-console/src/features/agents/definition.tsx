/**
 * Readable rendering of an agent's versioned config (WP-C3.1; console-spec
 * §9.1). This is also journey W16's governance view: the per-tool permission
 * policies (`always_allow` / `always_ask` / `always_deny`) render as a table
 * with one line of microcopy per policy (DP-6), so a tenant admin can audit
 * what a tool is allowed to do without reading JSON. Bulky payloads
 * (multiagent roster, metadata) stay collapsed in the JsonViewer (DP-2).
 */
import type { ReactNode } from "react";
import type {
  AgentConfig,
  Metadata,
  PermissionPolicy,
  ToolConfig,
} from "@pi-managed/contracts";

import { CopyableId } from "../../ui/copyable-id.js";
import { JsonViewer } from "../../ui/json-viewer.js";
import { Table, type Column } from "../../ui/table.js";
import styles from "./agent-detail.module.css";

/** One line of microcopy per policy (DP-6; journey W16 language). */
const POLICY_EXPLANATION: Record<PermissionPolicy, string> = {
  always_allow: "runs without asking",
  always_ask: "each call needs a human confirmation",
  always_deny: "calls are blocked",
};

interface ToolRow {
  name: string;
  config: ToolConfig;
  isDefault: boolean;
}

function PolicyCell({ row }: { row: ToolRow }) {
  const policy = row.config.permissionPolicy;
  if (!policy) {
    return <>{row.isDefault ? "always_allow (API default)" : "inherits the default"}</>;
  }
  return (
    <span className={styles.policy}>
      <code className={styles.policyName}>{policy}</code>
      <span className={styles.policyNote}>{POLICY_EXPLANATION[policy]}</span>
    </span>
  );
}

const TOOL_COLUMNS: Array<Column<ToolRow>> = [
  {
    key: "tool",
    header: "Tool",
    render: (row) =>
      row.isDefault ? (
        <em>all tools (default)</em>
      ) : (
        <code className={styles.toolName}>{row.name}</code>
      ),
  },
  {
    key: "enabled",
    header: "Enabled",
    render: (row) =>
      row.config.enabled === undefined
        ? row.isDefault
          ? "yes (API default)"
          : "inherits the default"
        : row.config.enabled
          ? "yes"
          : "no",
  },
  {
    key: "policy",
    header: "Permission policy",
    render: (row) => <PolicyCell row={row} />,
  },
];

/** W16: per-tool permission policies, default first. */
function ToolPolicies({ tools }: { tools: AgentConfig["tools"] }) {
  if (!tools) {
    return (
      <p className={styles.note}>
        No tools config — all built-in tools are enabled with{" "}
        <code>always_allow</code> (the API default).
      </p>
    );
  }
  const rows: ToolRow[] = [
    { name: "(default)", config: tools.defaultConfig, isDefault: true },
    ...Object.entries(tools.configs)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, config]) => ({ name, config, isDefault: false })),
  ];
  return (
    <Table
      columns={TOOL_COLUMNS}
      rows={rows}
      rowKey={(row) => row.name}
      caption="Tool permissions"
    />
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.defRow}>
      <dt className={styles.defLabel}>{label}</dt>
      <dd className={styles.defValue}>{children}</dd>
    </div>
  );
}

/** The definition block of the detail page (and nothing else — reusable). */
export function AgentDefinition({
  config,
  metadata,
}: {
  config: AgentConfig | undefined;
  metadata?: Metadata;
}) {
  if (!config) {
    return <p className={styles.note}>This payload carries no expanded config.</p>;
  }
  return (
    <div className={styles.definition}>
      <dl className={styles.defList}>
        <Row label="Model">
          <code className={styles.model}>
            {config.model.provider} / {config.model.id}
          </code>
          {config.model.thinkingLevel ? (
            <span className={styles.note}>
              {" "}
              thinking: {config.model.thinkingLevel}
            </span>
          ) : null}
        </Row>
        <Row label="System prompt">
          {config.systemPrompt ? (
            <details className={styles.prompt}>
              <summary>show prompt ({config.systemPrompt.length} chars)</summary>
              <pre className={styles.promptText}>{config.systemPrompt}</pre>
            </details>
          ) : (
            "—"
          )}
        </Row>
        <Row label="Skills">
          {config.skills?.length ? (
            <ul className={styles.refList}>
              {config.skills.map((skill) => (
                <li key={`${skill.skillId}@${skill.version ?? "latest"}`}>
                  <CopyableId id={skill.skillId} maxLength={26} />{" "}
                  <span className={styles.note}>
                    ({skill.type}
                    {skill.version ? `, v${skill.version}` : ""})
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            "—"
          )}
        </Row>
        <Row label="Extensions">
          {config.extensions?.length ? config.extensions.join(", ") : "—"}
        </Row>
        <Row label="MCP servers">
          {config.mcpServers?.length ? (
            <ul className={styles.refList}>
              {config.mcpServers.map((server) => (
                <li key={server.name}>
                  {server.name}{" "}
                  <code className={styles.mcpUrl}>{server.url}</code>
                </li>
              ))}
            </ul>
          ) : (
            "—"
          )}
        </Row>
      </dl>

      <h3 className={styles.subheading}>Tool permissions</h3>
      <ToolPolicies tools={config.tools} />

      {config.multiagent || metadata ? (
        <div className={styles.payloads}>
          {config.multiagent ? (
            <JsonViewer
              label={`multiagent roster (${config.multiagent.roster.length})`}
              value={config.multiagent}
            />
          ) : null}
          {metadata ? <JsonViewer label="metadata" value={metadata} /> : null}
        </div>
      ) : null}
    </div>
  );
}
