/**
 * Ambient session status (WP-C2.5; console-spec §8.3, DP-11): the document
 * title and favicon reflect the VIEWED session's status — running /
 * completed / failed / requires_action — so a background tab is informative.
 *
 * The mapping half is pure (status → title / favicon data: URI); the
 * apply/restore half touches `document` and is driven from one mount point
 * in the app shell (`src/app/shell.tsx`), which applies on session routes
 * and restores the page defaults on route leave/unmount.
 *
 * Favicons are inline SVG data: URIs — bundled bytes, no request, no
 * external host (§3.4). Each status pairs a distinct glyph with its
 * status-chip tone (shape + color, not color alone — DP-13), in fixed
 * mid-tones legible on both light and dark tab strips (a data: SVG cannot
 * read the page's custom-property tokens).
 */
import type { Session } from "@pi-managed/contracts";

/** The four DP-11 ambient states. */
export type AmbientStatus =
  | "running"
  | "completed"
  | "failed"
  | "requires_action";

/**
 * The ambient state of a session, or `null` when nothing is worth a badge:
 * a live status (`running`/`rescheduling`) is "running"; otherwise the last
 * stop reason decides (`error` reads as "failed"). A session that never ran
 * (null stopReason) or stopped for a reason outside the DP-11 four
 * (`budget_exhausted`, `user_interrupt`) keeps the page defaults.
 */
export function ambientStatusOf(
  session: Pick<Session, "status" | "stopReason">,
): AmbientStatus | null {
  if (session.status === "running" || session.status === "rescheduling") {
    return "running";
  }
  switch (session.stopReason) {
    case "requires_action":
      return "requires_action";
    case "completed":
      return "completed";
    case "error":
      return "failed";
    default:
      return null;
  }
}

/** Tab title for a status: the verbatim API token (same vocabulary as the
 * StatusChip/CLI) in front of the page's own title. */
export function ambientTitle(status: AmbientStatus, baseTitle: string): string {
  return `${status} — ${baseTitle}`;
}

// One glyph per status on a 16×16 viewBox: dot (running), check (completed),
// cross (failed), exclamation (requires_action).
const GLYPHS: Record<AmbientStatus, string> = {
  running: '<circle cx="8" cy="8" r="6" fill="#4459d4"/>',
  completed:
    '<path d="M3.5 8.5l3 3L12.5 5" fill="none" stroke="#2f9e57"' +
    ' stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>',
  failed:
    '<path d="M4.5 4.5l7 7m0-7l-7 7" fill="none" stroke="#d8433c"' +
    ' stroke-width="3" stroke-linecap="round"/>',
  requires_action:
    '<path d="M8 2v7.5" fill="none" stroke="#d4a72c" stroke-width="3"' +
    ' stroke-linecap="round"/><circle cx="8" cy="13.5" r="1.75" fill="#d4a72c"/>',
};

/** Favicon for a status, as a self-contained `data:image/svg+xml` URI. */
export function ambientFavicon(status: AmbientStatus): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${GLYPHS[status]}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// --- Apply / restore ---------------------------------------------------------

/** The page defaults captured on the first apply since the last restore;
 * `favicon: null` records that no `<link rel="icon">` existed. */
let defaults: { title: string; favicon: string | null } | null = null;

function faviconLink(): HTMLLinkElement | null {
  return document.querySelector<HTMLLinkElement>('link[rel="icon"]');
}

/** Stamp `status` onto the tab: title via {@link ambientTitle}, favicon via
 * {@link ambientFavicon} (creating the link element if the page has none). */
export function applyAmbientStatus(status: AmbientStatus): void {
  defaults ??= {
    title: document.title,
    favicon: faviconLink()?.getAttribute("href") ?? null,
  };
  document.title = ambientTitle(status, defaults.title);
  let link = faviconLink();
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.append(link);
  }
  link.setAttribute("href", ambientFavicon(status));
}

/** Put the captured page defaults back (route leave / shell unmount); a
 * no-op when nothing was applied since the last restore. */
export function restoreAmbientDefaults(): void {
  if (defaults === null) return;
  document.title = defaults.title;
  const link = faviconLink();
  if (defaults.favicon === null) {
    link?.remove();
  } else {
    link?.setAttribute("href", defaults.favicon);
  }
  defaults = null;
}
