/**
 * Full-page navigation to an external hosted URL (WP-C5.4). Isolated to one
 * line so the billing checkout/portal link-out has a single, testable call site
 * — the console redirects the browser to the payment engine's hosted page; the
 * card is entered there, never in the console (§11.9). jsdom does not implement
 * navigation, so tests mock THIS collaborator rather than `window.location`.
 */
export function redirectToExternal(url: string): void {
  window.location.assign(url);
}
