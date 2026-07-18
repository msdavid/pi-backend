/**
 * Signup + first-run (WP-C3.7; console-spec §9.6, §5.3, journey W8).
 *
 * MODE-GATED AT RENDER: the route exists in every mode (deep links resolve,
 * §1.4; the console degrades gracefully, §3.3), but the flow renders only
 * when `/console/config` reports saas mode with onboarding enabled — every
 * other mode points at sign-in instead. Renders OUTSIDE the auth gate
 * (`shell.tsx` `ConsoleRoot`): signup precedes any console session.
 *
 * The W8 flow: tenant name + admin email (NO payment details, §9.6) →
 * `POST /v1/onboarding/signup` → the admin key shown EXACTLY ONCE behind
 * copy-and-confirm (cannot proceed without confirming) → automatic sign-in
 * through the ordinary console-session flow → the first-run checklist
 * (`./first-run-checklist.tsx`). A signed-in visit to /signup lands
 * directly on the checklist, which is how it stays reachable while
 * incomplete. A repeat sign-up for a known email returns no key (the
 * backend never re-issues credentials to a public caller) — that case
 * renders "check with your admin".
 *
 * The raw key lives only in the signup mutation result; confirming +
 * signing in resets the mutation, dropping the last in-memory copy (§4.1).
 */
import { createLazyRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import type { FormEvent } from "react";

import { ConsoleApiError } from "../../api/client.js";
import {
  useConsoleConfig,
  useConsoleSession,
  useCreateConsoleSession,
} from "../../api/console.js";
import { useSignup } from "../../api/onboarding.js";
import { Button } from "../../ui/button.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { Input } from "../../ui/input.js";
import { SecretReveal } from "../../ui/secret-reveal.js";
import { FirstRunChecklist } from "./first-run-checklist.js";
import styles from "./signup.module.css";

export const Route = createLazyRoute("/signup")({
  component: SignupPage,
});

function SignupPage() {
  const config = useConsoleConfig();

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

  const enabled =
    config.data.mode === "saas" && config.data.onboardingEnabled;
  if (!enabled) {
    return (
      <main className={styles.page}>
        <div className={styles.card}>
          <h1 className={styles.title}>Sign up</h1>
          <p className={styles.lead}>
            Self-service sign-up is not enabled on this backend. If you were
            handed an API key,{" "}
            <Link to="/" className={styles.link}>
              sign in
            </Link>{" "}
            instead.
          </p>
        </div>
      </main>
    );
  }

  return <SignupFlow />;
}

/** The saas flow: form → key-once → auto sign-in → checklist (W8). */
function SignupFlow() {
  const session = useConsoleSession();
  const signupMutation = useSignup();
  // Set once the key is confirmed and sign-in fired: bridges the gap where
  // the signup result is already dropped but the session query is still
  // refetching, so the form never flashes back.
  const [signingIn, setSigningIn] = useState(false);

  if (signupMutation.data) {
    const { apiKey } = signupMutation.data;
    return apiKey ? (
      <KeyOnceScreen
        rawKey={apiKey.key}
        onSignedIn={() => {
          setSigningIn(true);
          // Drops the last in-memory copy of the raw key (§4.1, §9.6).
          signupMutation.reset();
        }}
      />
    ) : (
      <ExistingTenantScreen />
    );
  }

  if (session.data) return <FirstRunChecklist />;
  if (session.isPending || signingIn) {
    return (
      <main className={styles.page}>
        <p role="status">{signingIn ? "Signing you in…" : "Loading…"}</p>
      </main>
    );
  }
  if (
    session.isError &&
    !(session.error instanceof ConsoleApiError && session.error.status === 401)
  ) {
    return (
      <main className={styles.page}>
        <ErrorAlert label="the console session" error={session.error} />
        <Button onClick={() => void session.refetch()}>Retry</Button>
      </main>
    );
  }

  // Signed out (401): the signup form.
  return <SignupForm signup={signupMutation} />;
}

function SignupForm({ signup }: { signup: ReturnType<typeof useSignup> }) {
  const [tenantName, setTenantName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = tenantName.trim();
    const email = adminEmail.trim();
    if (!name || !email || signup.isPending) return;
    signup.mutate({ tenantName: name, adminEmail: email });
  }

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>Sign up</h1>
        <p className={styles.lead}>
          Create a tenant for your team. No payment details required.
        </p>
        <form onSubmit={onSubmit}>
          <Input
            label="Tenant name"
            autoComplete="organization"
            value={tenantName}
            onChange={(e) => setTenantName(e.target.value)}
            hint="How your workspace shows up in the console — usually your team or company name."
          />
          <Input
            label="Admin email"
            type="email"
            autoComplete="email"
            value={adminEmail}
            onChange={(e) => setAdminEmail(e.target.value)}
            hint="One tenant per email. Your admin API key is issued to this sign-up."
          />
          {signup.isError ? (
            <ErrorAlert label="sign-up" error={signup.error} />
          ) : null}
          <Button
            type="submit"
            variant="primary"
            className={styles.submit}
            disabled={
              signup.isPending ||
              tenantName.trim() === "" ||
              adminEmail.trim() === ""
            }
          >
            {signup.isPending ? "Creating tenant…" : "Create tenant"}
          </Button>
        </form>
        <p className={styles.lead}>
          Already have an API key?{" "}
          <Link to="/" className={styles.link}>
            Sign in
          </Link>
          .
        </p>
      </div>
    </main>
  );
}

/**
 * The admin key, shown EXACTLY ONCE (§9.6): copy-and-confirm via the shared
 * {@link SecretReveal} — the continue action stays disabled (with its
 * reason visible, §6.1) until the user confirms the key is stored. Continue
 * exchanges the key for a console session (the ordinary sign-in flow) and
 * tells the parent to drop it.
 */
function KeyOnceScreen({
  rawKey,
  onSignedIn,
}: {
  rawKey: string;
  onSignedIn: () => void;
}) {
  const createSession = useCreateConsoleSession();

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>Your tenant is ready</h1>
        <p className={styles.lead}>
          This is your admin API key. It is shown only this once — it is
          stored hashed and can never be displayed again. Copy it into your
          password manager now.
        </p>
        <SecretReveal
          label="admin API key"
          secret={rawKey}
          copyLabel="Copy admin API key"
          // The lead above carries the §9.6 show-once warning.
          warning={null}
          confirmText="I copied the key and stored it somewhere safe."
          confirmLabel={
            createSession.isPending ? "Signing in…" : "Continue to the console"
          }
          confirmPending={createSession.isPending}
          lockedReason="Confirm you stored the key to continue — it cannot be shown again."
          onConfirm={() =>
            createSession.mutate({ apiKey: rawKey }, { onSuccess: onSignedIn })
          }
        >
          {createSession.isError ? (
            <ErrorAlert label="sign-in" error={createSession.error} />
          ) : null}
        </SecretReveal>
      </div>
    </main>
  );
}

/** Repeat sign-up: the tenant exists, no key is re-issued (R0.3). */
function ExistingTenantScreen() {
  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>This email is already signed up</h1>
        <p className={styles.lead}>
          A tenant already exists for that admin email, so no new key was
          issued. If you lost your key, ask a tenant admin to issue you a new
          one — then{" "}
          <Link to="/" className={styles.link}>
            sign in
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
