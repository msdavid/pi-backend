/**
 * Recents + favorites (WP-C1.7; console-spec §7.2): "favorites/recents are
 * client-side per-browser state (no API)". Stored in localStorage — these are
 * `{id, title}` bookmarks, preferences rather than secrets, so §4.1 (which
 * bans key material) does not apply. Every accessor is failure-tolerant:
 * storage being unavailable (privacy mode) degrades to empty lists.
 */

export interface SessionShortcut {
  id: string;
  title?: string;
}

const RECENTS_KEY = "pi-console.recent-sessions";
const FAVORITES_KEY = "pi-console.favorite-sessions";

/** Home shows at most this many recently viewed sessions. */
export const RECENTS_LIMIT = 8;

function read(key: string): SessionShortcut[] {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is SessionShortcut =>
        item !== null &&
        typeof item === "object" &&
        typeof (item as SessionShortcut).id === "string",
    );
  } catch {
    return [];
  }
}

function write(key: string, value: SessionShortcut[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Best-effort: a full or unavailable storage never breaks the page.
  }
}

/** Recently viewed sessions, most recent first. */
export function listRecents(): SessionShortcut[] {
  return read(RECENTS_KEY);
}

/** Record a session-detail visit (called by the detail route). */
export function recordRecent(shortcut: SessionShortcut): void {
  const rest = listRecents().filter((s) => s.id !== shortcut.id);
  write(RECENTS_KEY, [shortcut, ...rest].slice(0, RECENTS_LIMIT));
}

/** Starred sessions, in the order they were starred. */
export function listFavorites(): SessionShortcut[] {
  return read(FAVORITES_KEY);
}

export function isFavorite(id: string): boolean {
  return listFavorites().some((s) => s.id === id);
}

/** Star/unstar; returns the new favorite state for the id. */
export function toggleFavorite(shortcut: SessionShortcut): boolean {
  const favorites = listFavorites();
  if (favorites.some((s) => s.id === shortcut.id)) {
    write(
      FAVORITES_KEY,
      favorites.filter((s) => s.id !== shortcut.id),
    );
    return false;
  }
  write(FAVORITES_KEY, [...favorites, shortcut]);
  return true;
}
