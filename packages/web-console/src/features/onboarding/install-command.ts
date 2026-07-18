/**
 * The canonical Pi-extension install one-liner (README §"Install the client
 * extension"; the backend's saas signup response returns the same command —
 * `DEFAULT_INSTALL_COMMAND` in `domain/onboarding/signup.ts`).
 *
 * A module of its own so both the first-run checklist (signup chunk) and the
 * Settings index (W8 step 3: "reprinted in Settings any time") can share it
 * without pulling each other's route chunk in.
 */
export const INSTALL_COMMAND = "pi install npm:@pi-managed/client";
