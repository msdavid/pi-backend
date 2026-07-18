/**
 * Vitest setup for the "console" (jsdom) project.
 *
 * - Registers `@testing-library/jest-dom` matchers on vitest's `expect`.
 * - Restores Web Storage: Node 22+ defines experimental `localStorage` /
 *   `sessionStorage` globals that are `undefined` unless Node is started with
 *   `--localstorage-file`. Because the key already exists on `globalThis`,
 *   vitest's jsdom population skips jsdom's own Storage, leaving
 *   `window.localStorage === undefined`. The shim below stands in for that
 *   COLLABORATOR (browser storage) only when it is missing — it is never the
 *   subject under test (CONVENTIONS.md, "Fakes at the seam").
 */
import "@testing-library/jest-dom/vitest";

class MemoryStorage {
  #map = new Map<string, string>();

  get length(): number {
    return this.#map.size;
  }

  key(index: number): string | null {
    return [...this.#map.keys()][index] ?? null;
  }

  getItem(name: string): string | null {
    return this.#map.get(name) ?? null;
  }

  setItem(name: string, value: string): void {
    this.#map.set(name, String(value));
  }

  removeItem(name: string): void {
    this.#map.delete(name);
  }

  clear(): void {
    this.#map.clear();
  }
}

for (const key of ["localStorage", "sessionStorage"] as const) {
  if (globalThis[key] === undefined) {
    Object.defineProperty(globalThis, key, {
      value: new MemoryStorage(),
      configurable: true,
      writable: true,
    });
  }
}
