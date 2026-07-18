/**
 * Sign-in screen (WP-C1.6; console-spec §4.1–§4.2, §5 copy variants; W1).
 *
 * Fetches `GET /console/config` first and renders the mode-appropriate copy:
 * solo explains how to obtain the first key, team addresses the key your
 * admin issued (least privilege), saas frames it as a plain sign-in (the
 * signup page is phase 3). The pasted key exists only in transient component
 * state and the `POST /console/session` body — on success the state is
 * cleared and the screen unmounts; nothing key-like ever touches
 * localStorage/sessionStorage (§4.1).
 */
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type { ConsoleMode } from "@pi-managed/contracts";

import { ConsoleApiError } from "../../api/client.js";
import {
  useConsoleConfig,
  useCreateConsoleSession,
} from "../../api/console.js";
import { errorDocsUrl } from "../../lib/errors.js";
import { Button } from "../../ui/button.js";
import { Input } from "../../ui/input.js";
import styles from "./sign-in.module.css";

/** Mode copy variants (console-spec §5.1–§5.3: copy is the only difference). */
const MODE_COPY: Record<ConsoleMode, { lead: string; hint: string }> = {
  solo: {
    lead: "Paste an API key for your backend to start browsing.",
    hint: "First run? Create your first tenant and admin key with POST /v1/onboarding/signup, then mint day-to-day keys with POST /v1/api-keys.",
  },
  team: {
    lead: "Paste the API key your admin issued you.",
    hint: "A read-scoped key is enough for browsing — ask your admin for the smallest scope you need.",
  },
  saas: {
    lead: "Sign in with an API key for your tenant.",
    hint: "Keys are shown once at issuance — if you lost yours, ask a tenant admin to issue a new one.",
  },
};

export function SignInPage() {
  const config = useConsoleConfig();
  const createSession = useCreateConsoleSession();
  const [apiKey, setApiKey] = useState("");

  if (config.isError) {
    return (
      <main className={styles.page}>
        <p role="alert" className={styles.loadError}>
          Could not load the console configuration: {config.error.message}
        </p>
        <Button onClick={() => void config.refetch()}>Retry</Button>
      </main>
    );
  }
  if (config.isPending) {
    return (
      <main className={styles.page}>
        <p role="status">Loading…</p>
      </main>
    );
  }

  const copy = MODE_COPY[config.data.mode];

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const key = apiKey.trim();
    if (!key || createSession.isPending) return;
    createSession.mutate(
      { apiKey: key },
      // Success unmounts this screen (the session query refetches); clearing
      // the state drops the last in-memory copy of the key (§4.1, W1).
      { onSuccess: () => setApiKey("") },
    );
  }

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>Pi Console</h1>
        <p className={styles.lead}>{copy.lead}</p>
        <form onSubmit={onSubmit}>
          <Input
            label="API key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            hint={copy.hint}
            error={signInError(createSession.error)}
          />
          <Button
            type="submit"
            variant="primary"
            className={styles.submit}
            disabled={createSession.isPending || apiKey.trim() === ""}
          >
            {createSession.isPending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        {/* WP-C3.7 (§5.3): the signup surface exists only in saas mode with
            onboarding enabled — everywhere else this link is absent. */}
        {config.data.mode === "saas" && config.data.onboardingEnabled ? (
          <p className={styles.lead}>
            New here?{" "}
            <Link to="/signup" className={styles.docsLink}>
              Create a tenant
            </Link>
            .
          </p>
        ) : null}
      </div>
    </main>
  );
}

/** DP-9: failures render the machine code + request id — never a bare
 * message — plus a "docs" link into the api-reference error envelope. */
function signInError(error: unknown): ReactNode {
  if (!error) return undefined;
  const docs = (
    <a
      className={styles.docsLink}
      href={errorDocsUrl()}
      target="_blank"
      rel="noreferrer"
    >
      docs
    </a>
  );
  if (error instanceof ConsoleApiError) {
    const facts = [error.code, error.requestId].filter(Boolean).join(" · ");
    const message =
      error.status === 401
        ? "That key was not accepted — check it and try again."
        : error.message;
    return (
      <>
        {facts ? `${message} (${facts})` : message} {docs}
      </>
    );
  }
  return (
    <>
      {error instanceof Error ? error.message : "Sign-in failed."} {docs}
    </>
  );
}
