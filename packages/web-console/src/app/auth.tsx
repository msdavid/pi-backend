/**
 * Session bootstrap + auth context (WP-C1.6; console-spec §4 client side).
 *
 * On boot the app calls `GET /console/session` (via `useConsoleSession`):
 * a 401 means "signed out" and renders the sign-in screen; success hydrates
 * an auth context `{ scopes, tenant, expiresAt }` for the shell. The browser
 * never sees the API key after sign-in — auth is the HttpOnly cookie, which
 * the fetch wrapper rides implicitly (§4.1/§4.3).
 */
import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { ConsoleSessionInfo } from "@pi-managed/contracts";

import { ConsoleApiError } from "../api/client.js";
import { useConsoleSession } from "../api/console.js";
import { SignInPage } from "../features/auth/sign-in.js";
import { Button } from "../ui/button.js";
import styles from "./auth.module.css";

const AuthContext = createContext<ConsoleSessionInfo | null>(null);

/** The signed-in console session; only rendered under a signed-in AuthGate. */
export function useAuth(): ConsoleSessionInfo {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside a signed-in AuthGate");
  return ctx;
}

/**
 * Gate the app on the console session: loading → boot screen, 401 → sign-in,
 * other failures → retryable error, success → children under the context.
 * A 401 on a background refetch (expiry, key revocation) lands here too and
 * drops the user back at sign-in.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const session = useConsoleSession();

  if (session.isError) {
    const error = session.error;
    if (error instanceof ConsoleApiError && error.status === 401) {
      return <SignInPage />;
    }
    return (
      <main className={styles.boot}>
        <p role="alert" className={styles.error}>
          Could not reach the backend: {error.message}
        </p>
        <Button onClick={() => void session.refetch()}>Retry</Button>
      </main>
    );
  }

  if (session.isPending) {
    return (
      <main className={styles.boot}>
        <p role="status">Loading…</p>
      </main>
    );
  }

  return (
    <AuthContext.Provider value={session.data}>{children}</AuthContext.Provider>
  );
}
