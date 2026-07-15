/**
 * Object-store composition root (§28).
 *
 * Factory + readiness wiring. Selects a {@link FilesystemObjectStore} (v1 default)
 * or an {@link S3ObjectStore} (SaaS) from config, and exposes a readiness probe
 * adapter for the `createApp` health plumbing (WP-P0.1).
 *
 * `versioningSupported` is exposed on each impl; the port interface is authoritative
 * (`domain/ports.ts`).
 */

import type { Config } from "../config/index.js";
import type { ObjectStore } from "../../domain/ports.js";
import { FilesystemObjectStore } from "./filesystem.js";
import { createS3ObjectStore, type S3ObjectStoreOptions } from "./s3.js";

export { FilesystemObjectStore } from "./filesystem.js";
export type { FilesystemObjectStoreOptions, ObjectStoreProbeResult } from "./filesystem.js";
export { S3ObjectStore, createS3ObjectStore, ensureS3Bucket } from "./s3.js";
export type { S3ObjectStoreOptions, S3Credentials } from "./s3.js";
export { createObjectStoreReadinessCheck } from "./readiness.js";

/** Discriminated config for selecting an object-store implementation. */
export type ObjectStoreConfig =
  | { kind: "filesystem"; root: string }
  | (S3ObjectStoreOptions & { kind: "s3" });

/**
 * Create an {@link ObjectStore} from a {@link ObjectStoreConfig}.
 *
 * The filesystem path performs no I/O on construction. The S3 path probes bucket
 * versioning (best-effort) and therefore is async; callers must `await`.
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
  }
}

/**
 * Derive the object store from the backend {@link Config} (§7.3). P0/v1 selects the
 * filesystem impl from `objectStoreRoot`; SaaS/S3 selection will land when the config
 * schema gains S3 fields (later WP).
 */
export async function objectStoreFromConfig(
  config: Config,
): Promise<ObjectStore> {
  return createObjectStore({ kind: "filesystem", root: config.objectStoreRoot });
}
