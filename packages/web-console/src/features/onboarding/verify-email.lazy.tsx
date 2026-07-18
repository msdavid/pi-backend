/**
 * Trial email-verification landing (WP-C5.4; console-spec §11.1). The
 * verification email links here with `?token=…`; the page posts it to the
 * public `POST /v1/onboarding/verify-email`, which activates the pending $5
 * trial grant EXACTLY once and moves the tenant `trial → active` (idempotent —
 * a replayed link still lands on "verified", never re-granting). A missing /
 * invalid / expired token renders the DP-9 failure with a resend path back to
 * the console.
 *
 * Public route (rendered outside the auth gate, `app/shell.tsx`): the link may
 * be opened before the recipient has signed in.
 */
import { createLazyRoute, Link, useSearch } from "@tanstack/react-router";

import { useVerifyEmail } from "../../api/billing.js";
import { ConsoleApiError } from "../../api/client.js";
import { Button } from "../../ui/button.js";
import { errorSummary } from "../../lib/errors.js";
import styles from "./signup.module.css";

export const Route = createLazyRoute("/verify-email")({
  component: VerifyEmailPage,
});

function VerifyEmailPage() {
  // strict:false — this lazy route declares no search schema; read the token
  // leniently (it comes from an out-of-band email link).
  const search = useSearch({ strict: false }) as { token?: string };
  const token = typeof search.token === "string" ? search.token : "";
  const verify = useVerifyEmail();

  const submit = () => {
    if (token) verify.mutate({ token });
  };

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>Verify your email</h1>
        {!token ? (
          <>
            <p className={styles.lead}>
              This link is missing its verification token. Open the most recent
              verification email and use its link, or resend one from the
              console.
            </p>
            <Link to="/" className={styles.link}>
              Go to the console
            </Link>
          </>
        ) : verify.isSuccess ? (
          <>
            <p className={styles.lead}>
              Email verified — your $5 trial balance is now active. It shows as a
              grant in your ledger history.
            </p>
            <Link to="/settings/billing" className={styles.link}>
              View balance
            </Link>
          </>
        ) : verify.isError ? (
          <>
            <p role="alert" className={styles.lead}>
              Couldn&apos;t verify:{" "}
              {verify.error instanceof ConsoleApiError && verify.error.status === 409
                ? "this link has expired. Resend a fresh one from the console."
                : errorSummary(verify.error)}
            </p>
            <Link to="/" className={styles.link}>
              Go to the console
            </Link>
          </>
        ) : (
          <>
            <p className={styles.lead}>
              Confirm to activate your $5 trial balance.
            </p>
            <Button
              variant="primary"
              onClick={submit}
              disabled={verify.isPending}
            >
              {verify.isPending ? "Verifying…" : "Verify my email"}
            </Button>
          </>
        )}
      </div>
    </main>
  );
}
