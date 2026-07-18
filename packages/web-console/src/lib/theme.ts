/**
 * Theme plumbing (console-spec §12.2: light + dark from day one).
 *
 * Tokens live in src/styles/tokens.css as custom properties on :root. Light
 * is the default; dark comes from the OS `prefers-color-scheme` unless the
 * user picked an explicit theme, which is stamped as `data-theme` on <html>
 * and persisted per-browser. "system" means no attribute — the media query
 * decides.
 */

export type ThemePreference = "light" | "dark" | "system";

/** localStorage key for the persisted preference (UI state, not a secret). */
const STORAGE_KEY = "pi-console.theme";

/** The persisted preference, defaulting to "system" when unset or invalid. */
export function getStoredTheme(): ThemePreference {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage unavailable (privacy mode) — fall through to "system".
  }
  return raw === "light" || raw === "dark" ? raw : "system";
}

/** Stamp (or clear, for "system") the `data-theme` attribute on <html>. */
export function applyTheme(pref: ThemePreference): void {
  const root = document.documentElement;
  if (pref === "system") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = pref;
  }
}

/** Persist a preference and apply it immediately. */
export function setTheme(pref: ThemePreference): void {
  try {
    if (pref === "system") {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, pref);
    }
  } catch {
    // Persisting is best-effort; still apply for the current page.
  }
  applyTheme(pref);
}
