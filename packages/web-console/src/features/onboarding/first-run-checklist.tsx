/**
 * First-run checklist (WP-C3.7; console-spec §9.6, DP-12, W8 §2).
 *
 * ONE path to first value: add a `model_provider_key` to a vault → create an
 * agent → start a first session and watch it live. Each step deep-links to
 * the real surface and detects completion via the real APIs
 * (`useFirstRunProgress` — ≥1 active model key credential, ≥1 agent, ≥1
 * session). Dismissible; reachable again by visiting /signup while signed
 * in, and — while incomplete — via the Home first-run card
 * (`features/home/home.lazy.tsx`, WP-C3.8).
 *
 * Trial verification (WP-C5.4, §11.1): in a billing-enabled saas deployment
 * the $5 trial activates only on email verification, and verification is the
 * gate BEFORE "start a first session" — an unverified tenant is fail-soft
 * suspended (reads work, no new work). So when `GET /v1/tenant/billing` reports
 * `verificationRequired`, the checklist prepends the resend notice and blocks
 * step 3 until verified. A deployment without billing (`404`) shows none of
 * this — solo/team and non-billing saas have no balance mechanics (§9.6).
 */
import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { useBilling, useResendVerification } from "../../api/billing.js";
import { useFirstRunProgress } from "../../api/onboarding.js";
import { Button } from "../../ui/button.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { UnverifiedNotice } from "../billing/widgets.js";
import { INSTALL_COMMAND } from "./install-command.js";
import styles from "./signup.module.css";

/** The CLI path step 3 teaches (DP-5; the install one-liner is shared with
 * the Settings index — see `./install-command.ts`). */
const DELEGATE_COMMAND = '/remote:delegate "fix the login bug"';

interface Step {
  key: string;
  done: boolean;
  title: string;
  description: ReactNode;
  to: string;
  linkLabel: string;
  /** Gated behind a prerequisite (trial verification) — link disabled. */
  blocked?: boolean;
}

export function FirstRunChecklist() {
  const navigate = useNavigate();
  const progress = useFirstRunProgress();
  // Trial verification is a saas-billing concern; a 404 (no billing) leaves
  // `unverified` false and the gate never engages.
  const billing = useBilling();
  const resend = useResendVerification();
  const unverified = billing.data?.verificationRequired === true;
  const resendOutcome = resend.isError
    ? ("error" as const)
    : resend.isSuccess
      ? resend.data.sent
        ? ("sent" as const)
        : ("noop" as const)
      : null;

  if (progress.isError) {
    return (
      <main className={styles.page}>
        <div className={styles.card}>
          <ErrorAlert label="first-run progress" error={progress.error} />
          <Button onClick={() => void progress.refetch()}>Retry</Button>
        </div>
      </main>
    );
  }
  if (progress.isPending) {
    return (
      <main className={styles.page}>
        <p role="status">Checking your setup…</p>
      </main>
    );
  }

  const steps: Step[] = [
    {
      key: "model-key",
      done: progress.data.hasModelProviderKey,
      title: "Add a model provider key",
      description:
        "Create a vault and add a model_provider_key credential — sessions fail closed without one.",
      to: "/resources/vaults",
      linkLabel: "Open vaults",
    },
    {
      key: "agent",
      done: progress.data.hasAgent,
      title: "Create an agent",
      description:
        "An agent is the named configuration (model, prompt, defaults) your sessions run.",
      to: "/agents",
      linkLabel: "Open agents",
    },
    {
      key: "session",
      done: progress.data.hasSession,
      title: "Start your first session and watch it live",
      description: (
        <>
          Install the Pi extension (
          <code className={styles.command}>{INSTALL_COMMAND}</code>) and
          delegate a task from your editor:{" "}
          <code className={styles.command}>{DELEGATE_COMMAND}</code>. It
          streams here as it runs.
          {unverified ? (
            <> Verify your email first — sessions can&apos;t start until then.</>
          ) : null}
        </>
      ),
      to: "/sessions",
      linkLabel: "Open sessions",
      // §11.1: an unverified trial is fail-soft suspended — no new sessions.
      blocked: unverified,
    },
  ];
  const doneCount = steps.filter((step) => step.done).length;
  const allDone = doneCount === steps.length;

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>
          {allDone ? "You're all set" : "Welcome to Pi"}
        </h1>
        <p className={styles.lead}>
          {allDone
            ? "Your tenant has a model key, an agent, and a running session — everything from here lives in the console."
            : "Three steps to your first live session."}
        </p>
        {unverified ? (
          <UnverifiedNotice
            onResend={() => resend.mutate()}
            pending={resend.isPending}
            outcome={resendOutcome}
          />
        ) : null}
        <ol className={styles.steps} aria-label="First-run checklist">
          {steps.map((step) => (
            <li key={step.key} className={styles.step}>
              <span
                className={
                  step.done
                    ? `${styles.stepStatus} ${styles.stepDone}`
                    : styles.stepStatus
                }
              >
                {step.done ? "Done" : "To do"}
              </span>
              <div className={styles.stepBody}>
                <h2 className={styles.stepTitle}>{step.title}</h2>
                <p className={styles.stepText}>{step.description}</p>
                {step.done ? null : step.blocked ? (
                  <span className={styles.stepText} aria-disabled="true">
                    Verify your email to unlock this step.
                  </span>
                ) : (
                  <Link to={step.to} className={styles.link}>
                    {step.linkLabel}
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ol>
        <p className={styles.progressLine} role="status">
          {doneCount} of {steps.length} steps done
        </p>
        <div className={styles.actions}>
          <Button
            variant={allDone ? "primary" : "secondary"}
            onClick={() => void navigate({ to: "/" })}
          >
            {allDone ? "Go to the console" : "Skip for now"}
          </Button>
        </div>
        {allDone ? null : (
          <p className={styles.reason}>
            You can come back any time — until it is complete, this checklist
            lives at /signup and Home links back to it.
          </p>
        )}
      </div>
    </main>
  );
}
