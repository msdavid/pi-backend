import { beforeEach, describe, expect, it } from "vitest";

import { applyTheme, getStoredTheme, setTheme } from "./theme.js";

describe("theme plumbing", () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it("defaults to 'system' when nothing is stored", () => {
    expect(getStoredTheme()).toBe("system");
  });

  it("treats an invalid stored value as 'system'", () => {
    window.localStorage.setItem("pi-console.theme", "solarized");
    expect(getStoredTheme()).toBe("system");
  });

  it("applyTheme stamps data-theme on <html>, and 'system' clears it", () => {
    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    applyTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    applyTheme("system");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("setTheme persists and applies; a later boot reads it back", () => {
    setTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(getStoredTheme()).toBe("dark");
  });

  it("setTheme('system') removes the stored preference", () => {
    setTheme("dark");
    setTheme("system");
    expect(window.localStorage.getItem("pi-console.theme")).toBeNull();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});
