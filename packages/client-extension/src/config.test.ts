import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveConfig,
  DEFAULT_SETTINGS,
  ENV_BACKEND_URL,
  loadSettingsFile,
  saveSettingsFile,
} from "./config.js";

describe("config defaults", () => {
  it("applies documented defaults", () => {
    const c = resolveConfig(undefined, {});
    expect(c.pollingIntervalMs).toBe(5000);
    expect(c.streamTimeoutMs).toBe(1_800_000);
    expect(c.delegationPolicy).toBe("confirm");
    expect(c.outputsDir).toBe("./.pi-managed/outputs/");
    expect(c.apiKeyRef).toBe("pi-managed-backend");
    expect(c.backendUrl).toBeUndefined();
    expect(c.tenant).toBeUndefined();
  });

  it("DEFAULT_SETTINGS matches resolveConfig({})", () => {
    expect(DEFAULT_SETTINGS).toEqual(resolveConfig(undefined, {}));
  });
});

describe("config precedence (env > settings > defaults)", () => {
  it("settings override defaults", () => {
    const c = resolveConfig(
      { pollingIntervalMs: 1000, backendUrl: "https://settings.example" },
      {},
    );
    expect(c.pollingIntervalMs).toBe(1000);
    expect(c.backendUrl).toBe("https://settings.example");
    // untouched defaults survive
    expect(c.outputsDir).toBe(DEFAULT_SETTINGS.outputsDir);
  });

  it("env overrides settings and defaults for backendUrl", () => {
    const c = resolveConfig(
      { backendUrl: "https://settings.example", pollingIntervalMs: 1000 },
      { [ENV_BACKEND_URL]: "https://env.example" },
    );
    expect(c.backendUrl).toBe("https://env.example");
    // env only overrides backendUrl, not other keys
    expect(c.pollingIntervalMs).toBe(1000);
  });

  it("rejects an invalid delegation policy", () => {
    expect(() =>
      resolveConfig({ delegationPolicy: "bogus" as never }, {}),
    ).toThrow();
  });

  it("rejects a non-positive polling interval", () => {
    expect(() => resolveConfig({ pollingIntervalMs: 0 }, {})).toThrow();
  });
});

describe("settings file round-trip", () => {
  it("loads and merges the piManaged block, preserving other keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-managed-cfg-"));
    const file = join(dir, "settings.json");
    try {
      // pre-existing settings.json with other keys + a stale piManaged block
      saveSettingsFile(file, { backendUrl: "https://old.example", apiKeyRef: "pi-managed-backend" });
      // write a foreign key alongside
      const raw = JSON.parse(loadFile(file));
      raw.theme = "dark";
      writeRaw(file, raw);

      saveSettingsFile(file, { backendUrl: "https://new.example" });

      const loaded = loadSettingsFile(file);
      expect(loaded.backendUrl).toBe("https://new.example");
      expect(loaded.apiKeyRef).toBe("pi-managed-backend"); // preserved by merge

      const after = JSON.parse(loadFile(file));
      expect(after.theme).toBe("dark"); // foreign keys untouched
      expect(after.piManaged.backendUrl).toBe("https://new.example");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns {} when the file is absent", () => {
    expect(loadSettingsFile(join(tmpdir(), "definitely-missing.json"))).toEqual({});
  });
});

// helpers using node:fs directly (avoid circular import of saveSettingsFile)
import { readFileSync, writeFileSync } from "node:fs";
function loadFile(p: string): string {
  return readFileSync(p, "utf8");
}
function writeRaw(p: string, obj: unknown): void {
  writeFileSync(p, JSON.stringify(obj, null, 2));
}
