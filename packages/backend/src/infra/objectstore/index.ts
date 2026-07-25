/**
 * Object-store composition root (§28).
 *
 * Factory + readiness wiring. Selects a {@link FilesystemObjectStore} (v1 default),
 * an {@link S3ObjectStore}, or a {@link GCSObjectStore} (SaaS) from config, and
 * exposes a readiness probe adapter for the `createApp` health plumbing (WP-P0.1).
 *
 * `versioningSupported` is exposed on each impl; the port interface is authoritative
 * (`domain/ports.ts`).
 */

import type { Config } from "../config/index.js";
import type { ObjectStore } from "../../domain/ports.js";
import { FilesystemObjectStore } from "./filesystem.js";
import { createS3ObjectStore, type S3ObjectStoreOptions } from "./s3.js";
import { createGCSObjectStore, type GCSObjectStoreOptions } from "./gcs.js";

export { FilesystemObjectStore } from "./filesystem.js";
export type { FilesystemObjectStoreOptions, ObjectStoreProbeResult } from "./filesystem.js";
export { S3ObjectStore, createS3ObjectStore, ensureS3Bucket } from "./s3.js";
export type { S3ObjectStoreOptions, S3Credentials } from "./s3.js";
export { GCSObjectStore, createGCSObjectStore, ensureGCSBucket } from "./gcs.js";
export type { GCSObjectStoreOptions, GCSCredentials } from "./gcs.js";
export { createObjectStoreReadinessCheck } from "./readiness.js";

/** Discriminated config for selecting an object-store implementation. */
export type ObjectStoreConfig =
  | { kind: "filesystem"; root: string }
  | (S3ObjectStoreOptions & { kind: "s3" })
  | (GCSObjectStoreOptions & { kind: "gcs" });

/**
 * Create an {@link ObjectStore} from a {@link ObjectStoreConfig}.
 *
 * The filesystem path performs no I/O on construction. The S3 and GCS paths probe
 * bucket versioning (best-effort) and therefore are async; callers must `await`.
 */
export async function createObjectStore(
  config: ObjectStoreConfig,
): Promise<ObjectStore> {
  switch (config.kind) {
    case "filesystem":
      return new FilesystemObjectStore({ root: config.root });
    case "s3": {
      const { kind: _kind, ...opts } = config;
      return createS3ObjectStore(opts);
    }
    case "gcs": {
      const { kind: _kind, ...opts } = config;
      return createGCSObjectStore(opts);
    }
  }
}

/**
 * Derive the object store from the backend {@link Config} (§7.3), per
 * `OBJECT_STORE_KIND`:
 *
 * - `filesystem` (default) — a local directory at `objectStoreRoot`.
 * - `gcs` — Google Cloud Storage on `gcsBucket`, authenticating via Application Default
 *   Credentials. The config schema guarantees the bucket is set in this mode (it fails
 *   closed at load), so there is no fallback branch here to silently write durable state
 *   to local disk.
 *
 * S3 remains a composition-time injection (`createApp({ objectStoreConfig })`) — it needs
 * endpoint/region/credential fields the env schema does not carry.
 */
export async function objectStoreFromConfig(
  config: Config,
): Promise<ObjectStore> {
  switch (config.objectStoreKind) {
    case "gcs": {
      if (!config.gcsBucket) {
        throw new Error(
          "objectStoreFromConfig: config.gcsBucket is required when objectStoreKind is 'gcs' (set GCS_BUCKET)",
        );
      }
      return createObjectStore({ kind: "gcs", bucket: config.gcsBucket });
    }
    case "filesystem":
      return createObjectStore({ kind: "filesystem", root: config.objectStoreRoot });
  }
}
