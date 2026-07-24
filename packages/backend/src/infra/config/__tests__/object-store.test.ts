/**
 * Object-store selection from config (§7.3, §28).
 *
 * `OBJECT_STORE_KIND` picks the impl the composition root builds. The contract here is
 * the DEFAULT (a local directory — unchanged for every existing deployment) and the
 * FAIL-CLOSED edge: `gcs` with no bucket must refuse to load rather than silently write
 * durable state (JSONL transcripts, snapshots) to an unbacked host directory.
 *
 * The fail-closed cases assert on `ConfigSchema` rather than `loadConfig`, because the
 * loader reports invalid config via `process.exit(1)`.
 */

import { describe, it, expect } from "vitest";
import { loadConfig, ConfigSchema } from "../index.js";
import { objectStoreFromConfig, FilesystemObjectStore } from "../../objectstore/index.js";
import type { Config } from "../index.js";

describe("object-store config selection", () => {
  it("defaults to the local filesystem store", () => {
    const cfg = loadConfig({ env: {}, file: {} });
    expect(cfg.objectStoreKind).toBe("filesystem");
    expect(cfg.objectStoreRoot).toBe("./data/objectstore");
    expect(cfg.gcsBucket).toBeUndefined();
  });

  it("selects GCS from OBJECT_STORE_KIND + GCS_BUCKET", () => {
    const cfg = loadConfig({
      env: { OBJECT_STORE_KIND: "gcs", GCS_BUCKET: "pi-objects" },
      file: {},
    });
    expect(cfg.objectStoreKind).toBe("gcs");
    expect(cfg.gcsBucket).toBe("pi-objects");
  });

  it("takes env over the config file for both fields", () => {
    const cfg = loadConfig({
      env: { GCS_BUCKET: "from-env" },
      file: { objectStoreKind: "gcs", gcsBucket: "from-file" },
    });
    expect(cfg.objectStoreKind).toBe("gcs");
    expect(cfg.gcsBucket).toBe("from-env");
  });

  it("fails closed when the kind is gcs but no bucket is set", () => {
    const res = ConfigSchema.safeParse({ objectStoreKind: "gcs" });
    expect(res.success).toBe(false);
    expect(res.error?.issues.some((i) => i.path.join(".") === "gcsBucket")).toBe(true);
  });

  it("rejects an empty GCS bucket rather than treating it as unset", () => {
    const res = ConfigSchema.safeParse({ objectStoreKind: "gcs", gcsBucket: "" });
    expect(res.success).toBe(false);
  });

  it("does not accept s3 as an env-selectable kind (composition-time injection only)", () => {
    const res = ConfigSchema.safeParse({ objectStoreKind: "s3" });
    expect(res.success).toBe(false);
  });

  it("builds a FilesystemObjectStore for the default kind", async () => {
    const cfg = loadConfig({ env: {}, file: {} });
    await expect(objectStoreFromConfig(cfg)).resolves.toBeInstanceOf(FilesystemObjectStore);
  });

  it("refuses to build a GCS store without a bucket", async () => {
    // Hand-built Config bypasses the schema refinement (e.g. a config object passed
    // across the session-worker process boundary) — the factory guards too.
    const cfg = { ...loadConfig({ env: {}, file: {} }), objectStoreKind: "gcs" } as Config;
    await expect(objectStoreFromConfig(cfg)).rejects.toThrow(/GCS_BUCKET/);
  });
});
