/**
 * Settings index — overview rendered inside the section layout
 * (`settings.lazy.tsx`): API keys (WP-C3.4), webhooks (WP-C3.4), tenant
 * dashboard (WP-C3.6), and — solo/team only — backend health (WP-C3.6).
 *
 * Also reprints the Pi-extension install instructions (journey W8 step 3:
 * "reprinted in Settings any time") — the same canonical command the saas
 * signup response returns (`installCommand`, backend
 * `domain/onboarding/signup.ts`) and the README documents for every mode,
 * so it renders mode-invariant here alongside the connect steps.
 */
import { createLazyRoute, Link } from "@tanstack/react-router";

import { useConsoleConfig } from "../../api/console.js";
import { Button } from "../../ui/button.js";
import { useCopy } from "../../ui/use-copy.js";
import { INSTALL_COMMAND } from "../onboarding/install-command.js";
import styles from "./settings.module.css";

export const Route = createLazyRoute("/settings/")({
  component: SettingsIndexPage,
});

function SettingsIndexPage() {
  const { copied, copy } = useCopy();
  const mode = useConsoleConfig().data?.mode;

  return (
    <>
      <p>
        Manage API keys, webhook endpoints, tenant usage and quota
        {mode === "saas" ? ", and your prepaid balance under Billing" : ""} —
        and, when self-hosting, backend health — from the sections above.
      </p>
      <section
        aria-label="Install the Pi extension"
        className={styles.installCard}
      >
        <h2 className={styles.installTitle}>Install the Pi extension</h2>
        <div className={styles.installCommandRow}>
          <code className={styles.installCommand}>{INSTALL_COMMAND}</code>
          <Button
            aria-label={`Copy command: ${INSTALL_COMMAND}`}
            onClick={() => void copy(INSTALL_COMMAND)}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <p className={styles.installHint}>
          Then run <code>/remote:config</code> in Pi and paste this backend&apos;s
          URL plus an API key —{" "}
          <Link to="/settings/api-keys" className={styles.subnavLink}>
            issue one under API keys
          </Link>
          .
        </p>
      </section>
    </>
  );
}
