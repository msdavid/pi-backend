/**
 * Email seam barrel (console spec §11.1 — WP-C5.1).
 *
 * The {@link EmailSender} interface lives in `domain/ports.ts`; this module
 * exports the default {@link NoopEmailSender} (dev/test: records messages so a
 * flow/test can read the verification token; delivers nothing). A real sender is
 * a drop-in impl configured from env — its provider SDK/credential lives only
 * there.
 */

export { NoopEmailSender, NOOP_EMAIL_SENDER } from "./noop-email-sender.js";
