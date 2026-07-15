/**
 * Filesystem-safe slug for memory-store mounts (§13.3).
 *
 * Derives a stable, lowercase, hyphen-separated slug from a display title:
 * non-alphanumeric runs collapse to a single `-`, leading/trailing hyphens
 * trimmed. Used as the `<slug>` segment of the guest mount path
 * `/mnt/memory/<slug>/` so a store's mount path is stable and human-readable
 * across sessions.
 *
 * ASCII-only on purpose: mount paths must be portable across sandbox
 * filesystems. Non-ASCII titles collapse to hyphens; an all-symbol title yields
 * an empty slug, which callers MUST fall back to the store id (§13.3 — the slug
 * is a convenience, not a unique key).
 */

/** Convert a display title to a filesystem-safe slug (§13.3). */
export function slugify(title: string): string {
  return title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
