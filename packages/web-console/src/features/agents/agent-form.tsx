/**
 * Shared create/edit agent form (WP-C3.1; console-spec §9.1, journey W10).
 *
 * The submitted body follows the contracts `AgentCreate` schema EXACTLY: the
 * structured fields cover `name` + `model` + `systemPrompt`; the remaining
 * `AgentCreate` fields (`tools`, `skills`, `extensions`, `mcpServers`,
 * `multiagent`, `metadata`) ride the "advanced config" JSON area. Validation
 * IS `AgentCreate.safeParse` — the messages the user sees are the zod issues
 * themselves, attached to the field their path names (no invented rules on
 * top of the contract).
 *
 * The edit dialog reuses this form with the agent's current version prefilled
 * and sends the built body as the PATCH: the backend merges field-level
 * (omitted fields keep their previous value) and creates version n+1 — the
 * `notice` prop carries that §9.1 copy.
 */
import { useEffect, useId, useState } from "react";
import type { FormEvent } from "react";
import { AgentCreate } from "@pi-managed/contracts";
import type { Agent } from "@pi-managed/contracts";

import { Button } from "../../ui/button.js";
import { cx } from "../../ui/cx.js";
import { Dialog } from "../../ui/dialog.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { Input } from "../../ui/input.js";
import styles from "./agent-form.module.css";

/** The form's editable surface; `advanced` holds the rest of the config as JSON. */
export interface AgentFormValues {
  name: string;
  provider: string;
  modelId: string;
  thinkingLevel: string;
  systemPrompt: string;
  advanced: string;
}

export const EMPTY_AGENT_FORM: AgentFormValues = {
  name: "",
  provider: "",
  modelId: "",
  thinkingLevel: "",
  systemPrompt: "",
  advanced: "",
};

/** `AgentCreate` fields that ride the advanced JSON area. */
const ADVANCED_KEYS = [
  "tools",
  "skills",
  "extensions",
  "mcpServers",
  "multiagent",
] as const;

/** Prefill for the edit dialog from the agent's current-version config. */
export function valuesFromAgent(agent: Agent): AgentFormValues {
  const config = agent.config;
  const advanced: Record<string, unknown> = {};
  for (const key of ADVANCED_KEYS) {
    if (config?.[key] !== undefined) advanced[key] = config[key];
  }
  if (agent.metadata !== undefined) advanced.metadata = agent.metadata;
  return {
    name: agent.name,
    provider: config?.model.provider ?? "",
    modelId: config?.model.id ?? "",
    thinkingLevel: config?.model.thinkingLevel ?? "",
    systemPrompt: config?.systemPrompt ?? "",
    advanced: Object.keys(advanced).length
      ? JSON.stringify(advanced, null, 2)
      : "",
  };
}

/** Zod issues mapped onto the field whose path they name. */
export interface AgentFormIssues {
  name?: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  systemPrompt?: string;
  /** Issues inside the advanced JSON (path-prefixed), or a parse failure. */
  advanced?: string[];
}

export type AgentBodyResult =
  | { ok: true; body: AgentCreate }
  | { ok: false; issues: AgentFormIssues };

/**
 * Build the `AgentCreate` body from the form values and validate it with the
 * contracts schema. The structured fields win over same-named keys in the
 * advanced JSON; empty optional fields are omitted (a PATCH then keeps the
 * previous value — backend field-level merge).
 */
export function buildAgentBody(values: AgentFormValues): AgentBodyResult {
  let extra: Record<string, unknown> = {};
  if (values.advanced.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(values.advanced);
    } catch {
      return { ok: false, issues: { advanced: ["advanced config is not valid JSON"] } };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false,
        issues: { advanced: ["advanced config must be a JSON object"] },
      };
    }
    extra = parsed as Record<string, unknown>;
  }
  const candidate: Record<string, unknown> = {
    ...extra,
    name: values.name,
    model: {
      provider: values.provider,
      id: values.modelId,
      ...(values.thinkingLevel.trim()
        ? { thinkingLevel: values.thinkingLevel.trim() }
        : {}),
    },
  };
  if (values.systemPrompt.trim()) candidate.systemPrompt = values.systemPrompt;

  const result = AgentCreate.safeParse(candidate);
  if (!result.success) {
    const issues: AgentFormIssues = {};
    const advanced: string[] = [];
    for (const issue of result.error.issues) {
      const [head, second] = issue.path;
      if (head === "name") issues.name ??= issue.message;
      else if (head === "model" && second === "provider")
        issues.provider ??= issue.message;
      else if (head === "model" && second === "id")
        issues.modelId ??= issue.message;
      else if (head === "model" && second === "thinkingLevel")
        issues.thinkingLevel ??= issue.message;
      else if (head === "model") issues.provider ??= issue.message;
      else if (head === "systemPrompt") issues.systemPrompt ??= issue.message;
      else advanced.push(`${issue.path.join(".") || "config"}: ${issue.message}`);
    }
    if (advanced.length) issues.advanced = advanced;
    return { ok: false, issues };
  }
  return { ok: true, body: result.data };
}

export interface AgentFormDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  submitLabel: string;
  /** §9.1 version-bump copy for the edit dialog, rendered above the fields. */
  notice?: string;
  initial: AgentFormValues;
  pending: boolean;
  /** The failed mutation error (DP-9), or null/undefined. */
  submitError?: unknown;
  onSubmit: (body: AgentCreate) => void;
}

/** Create/edit dialog around the shared form. */
export function AgentFormDialog({
  open,
  onClose,
  title,
  submitLabel,
  notice,
  initial,
  pending,
  submitError,
  onSubmit,
}: AgentFormDialogProps) {
  const [values, setValues] = useState(initial);
  const [issues, setIssues] = useState<AgentFormIssues>({});

  // A reopened dialog starts from the given prefill, never a stale draft.
  useEffect(() => {
    if (!open) {
      setValues(initial);
      setIssues({});
    }
  }, [open, initial]);

  function set<K extends keyof AgentFormValues>(key: K, value: string) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const built = buildAgentBody(values);
    if (!built.ok) {
      setIssues(built.issues);
      return;
    }
    setIssues({});
    onSubmit(built.body);
  }

  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <form onSubmit={submit} className={styles.form} noValidate>
        {notice ? <p className={styles.notice}>{notice}</p> : null}
        <Input
          label="Name"
          value={values.name}
          onChange={(e) => set("name", e.target.value)}
          error={issues.name}
          hint="Unique within the tenant."
          spellCheck={false}
        />
        <div className={styles.modelRow}>
          <Input
            label="Model provider"
            value={values.provider}
            onChange={(e) => set("provider", e.target.value)}
            error={issues.provider}
            placeholder="anthropic"
            spellCheck={false}
          />
          <Input
            label="Model id"
            value={values.modelId}
            onChange={(e) => set("modelId", e.target.value)}
            error={issues.modelId}
            placeholder="claude-sonnet-4"
            spellCheck={false}
          />
          <Input
            label="Thinking level"
            value={values.thinkingLevel}
            onChange={(e) => set("thinkingLevel", e.target.value)}
            error={issues.thinkingLevel}
            hint="Optional, provider-dependent (e.g. low / medium / high)."
            spellCheck={false}
          />
        </div>
        <TextareaField
          label="System prompt"
          value={values.systemPrompt}
          onChange={(value) => set("systemPrompt", value)}
          errors={issues.systemPrompt ? [issues.systemPrompt] : []}
          hint="Optional; blank omits the field (an edit then keeps the previous prompt)."
          rows={5}
        />
        <TextareaField
          label="Advanced config (JSON)"
          value={values.advanced}
          onChange={(value) => set("advanced", value)}
          errors={issues.advanced ?? []}
          hint="Optional JSON object with the remaining AgentCreate fields: tools, skills, extensions, mcpServers, multiagent, metadata."
          rows={7}
          mono
        />
        {submitError ? <ErrorAlert label="agent save" error={submitError} /> : null}
        <div className={styles.actions}>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Saving…" : submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Labeled textarea mirroring `ui/Input`'s label/hint/error wiring. */
function TextareaField({
  label,
  value,
  onChange,
  hint,
  errors,
  rows,
  mono = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  errors: string[];
  rows: number;
  mono?: boolean;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy =
    cx(errors.length ? errorId : undefined, hint ? hintId : undefined) ||
    undefined;

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className={cx(
          styles.textarea,
          mono && styles.mono,
          errors.length > 0 && styles.invalid,
        )}
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={errors.length ? true : undefined}
        aria-describedby={describedBy}
        spellCheck={false}
      />
      {hint ? (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      ) : null}
      {errors.length ? (
        <ul id={errorId} className={styles.errorList}>
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
