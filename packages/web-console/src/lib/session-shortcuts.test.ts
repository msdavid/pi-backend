import { beforeEach, describe, expect, it } from "vitest";

import {
  isFavorite,
  listFavorites,
  listRecents,
  recordRecent,
  RECENTS_LIMIT,
  toggleFavorite,
} from "./session-shortcuts.js";

beforeEach(() => {
  window.localStorage.clear();
});

describe("recents (console-spec §7.2 — per-browser, no API)", () => {
  it("records visits most-recent-first and dedupes by id", () => {
    recordRecent({ id: "sess_a", title: "first" });
    recordRecent({ id: "sess_b" });
    recordRecent({ id: "sess_a", title: "renamed" });
    expect(listRecents()).toEqual([
      { id: "sess_a", title: "renamed" },
      { id: "sess_b" },
    ]);
  });

  it("caps the list", () => {
    for (let i = 0; i < RECENTS_LIMIT + 3; i += 1) {
      recordRecent({ id: `sess_${i}` });
    }
    expect(listRecents()).toHaveLength(RECENTS_LIMIT);
    expect(listRecents()[0]?.id).toBe(`sess_${RECENTS_LIMIT + 2}`);
  });

  it("tolerates garbage in storage", () => {
    window.localStorage.setItem("pi-console.recent-sessions", "{not json");
    expect(listRecents()).toEqual([]);
    window.localStorage.setItem(
      "pi-console.recent-sessions",
      JSON.stringify([{ nope: 1 }, { id: "sess_ok" }]),
    );
    expect(listRecents()).toEqual([{ id: "sess_ok" }]);
  });
});

describe("favorites", () => {
  it("toggles on and off", () => {
    expect(toggleFavorite({ id: "sess_a", title: "t" })).toBe(true);
    expect(isFavorite("sess_a")).toBe(true);
    expect(listFavorites()).toEqual([{ id: "sess_a", title: "t" }]);
    expect(toggleFavorite({ id: "sess_a" })).toBe(false);
    expect(isFavorite("sess_a")).toBe(false);
    expect(listFavorites()).toEqual([]);
  });
});
