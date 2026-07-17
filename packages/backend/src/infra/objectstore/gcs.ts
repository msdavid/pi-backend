/**
 * Google Cloud Storage {@link ObjectStore} (§28) — for SaaS deployments (§3.2).
 *
 * Backed by `@google-cloud/storage`. Streaming get/put via
 * `createReadStream`/`createWriteStream` (resumable uploads disabled — single-shot
 * uploads match the streaming put contract and work against emulators).
 * `conditionalPut` uses the native `ifGenerationMatch` precondition. `list` uses
 * `getFilesStream` (paginated internally).
 *
 * ## ETag surface
 *
 * The port treats etags as opaque concurrency tokens (put → etag → conditionalPut,
 * with `head()` as the mismatch-recovery source). GCS's HTTP ETag cannot be used as
 * an upload precondition, so this adapter surfaces the object **generation** as the
 * etag everywhere (put/conditionalPut results, head, list) and validates
 * `conditionalPut(ifMatch)` via `ifGenerationMatch`. Callers never observe the
 * difference; do not mix etags across store implementations.
 *
 * Versioning: `versioningSupported` is probed at construction time (via bucket
 * metadata) when the store is created through {@link createGCSObjectStore}. The
 * probe is best-effort — on failure it falls back to the caller-supplied default.
 *
 * §25.5: credentials are passed only via the constructor options and never logged.
 */

import {
  Storage,
  type Bucket,
  type FileMetadata,
  type StorageOptions,
} from "@google-cloud/storage";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ObjectMeta, ObjectStore, PutResult } from "../../domain/ports.js";
import type { ObjectStoreProbeResult } from "./filesystem.js";

/** Inline service-account credentials (never logged). Omit to use ADC. */
export interface GCSCredentials {
  clientEmail: string;
  privateKey: string;
}

/** Options for {@link GCSObjectStore} / {@link createGCSObjectStore}. */
export interface GCSObjectStoreOptions {
  /** Bucket name. */
  bucket: string;
  /** GCP project id. Omit to let the SDK resolve it from the environment. */
  projectId?: string;
  /**
   * API endpoint override (e.g. `http://localhost:4443` for fake-gcs-server).
   * Omit for real GCS. A custom endpoint disables SDK auth (emulator use).
   */
  apiEndpoint?: string;
  /** Path to a service-account JSON key file. Omit to use ADC. */
  keyFilename?: string;
  /** Inline service-account credentials. Omit to use `keyFilename` or ADC. */
  credentials?: GCSCredentials;
  /** Inject a pre-built client (tests). Bypasses `apiEndpoint`/`credentials`. */
  client?: Storage;
  /**
   * Override the versioning probe result (tests / known buckets). When omitted,
   * {@link createGCSObjectStore} probes the bucket.
   */
  versioningSupported?: boolean;
}

/**
 * GCS-backed {@link ObjectStore}. Construct directly with a known
 * `versioningSupported` value, or via {@link createGCSObjectStore} to probe it.
 */
export class GCSObjectStore implements ObjectStore {
  readonly versioningSupported: boolean;
  readonly bucket: string;
  readonly client: Storage;
  private readonly bucketRef: Bucket;

  constructor(opts: GCSObjectStoreOptions) {
    this.bucket = opts.bucket;
    this.client = opts.client ?? new Storage(buildClientConfig(opts));
    this.bucketRef = this.client.bucket(opts.bucket);
    this.versioningSupported = opts.versioningSupported ?? false;
  }

  async put(key: string, stream: ReadableStream<Uint8Array>): Promise<PutResult> {
    const file = this.bucketRef.file(key);
    await pipeline(
      Readable.fromWeb(stream),
      file.createWriteStream({ resumable: false }),
    );
    return this.putResult(file.metadata);
  }

  async get(key: string): Promise<ReadableStream<Uint8Array>> {
    const file = this.bucketRef.file(key);
    // Reject up front on a missing key (the read stream would only error lazily).
    try {
      await file.getMetadata();
    } catch (err) {
      if (isNotFound(err)) throw new Error(`object not found: ${key}`);
      throw err;
    }
    return Readable.toWeb(file.createReadStream()) as ReadableStream<Uint8Array>;
  }

  async conditionalPut(
    key: string,
    stream: ReadableStream<Uint8Array>,
    ifMatch: string,
  ): Promise<PutResult> {
    // Etags surfaced by this store are generations (see module doc); anything
    // non-numeric cannot match any generation.
    const generation = Number(ifMatch);
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new Error(`conditional put failed: etag mismatch (${ifMatch})`);
    }
    const file = this.bucketRef.file(key, {
      preconditionOpts: { ifGenerationMatch: generation },
    });
    try {
      await pipeline(
        Readable.fromWeb(stream),
        file.createWriteStream({ resumable: false }),
      );
    } catch (err) {
      if (isPreconditionFailed(err)) {
        throw new Error(`conditional put failed: etag mismatch (${ifMatch})`);
      }
      throw err;
    }
    return this.putResult(file.metadata);
  }

  async delete(key: string): Promise<void> {
    await this.bucketRef.file(key).delete({ ignoreNotFound: true });
  }

  /**
   * Purge the object and every generation (§13.6). On a versioned bucket a plain
   * delete only archives the live generation, leaving prior (plaintext) generations
   * retrievable; here we enumerate all generations of the exact key (`versions:
   * true`) and delete each one. On a non-versioned bucket the sole live generation
   * is deleted, so this still hard-deletes the object.
   */
  async hardDelete(key: string): Promise<void> {
    const [files] = await this.bucketRef.getFiles({ prefix: key, versions: true });
    for (const file of files) {
      // `prefix` is a prefix match — only purge generations of the exact key. The
      // listed `File` handles carry their generation, so `delete()` targets it.
      if (file.name !== key) continue;
      await file.delete({ ignoreNotFound: true });
    }
  }

  async head(key: string): Promise<ObjectMeta | null> {
    let metadata: FileMetadata;
    try {
      [metadata] = await this.bucketRef.file(key).getMetadata();
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    return this.objectMeta(key, metadata);
  }

  async *list(prefix: string): AsyncIterable<ObjectMeta> {
    for await (const file of this.bucketRef.getFilesStream({ prefix })) {
      const f = file as { name: string; metadata: FileMetadata };
      yield this.objectMeta(f.name, f.metadata);
    }
  }

  /** Readiness probe: fetch bucket metadata for the configured bucket. */
  async probe(): Promise<ObjectStoreProbeResult> {
    try {
      await this.bucketRef.getMetadata();
      return { status: "up" };
    } catch (err) {
      return {
        status: "down",
        detail: `gcs bucket not reachable: ${(err as Error).message}`,
      };
    }
  }

  private putResult(metadata: FileMetadata): PutResult {
    const generation =
      metadata.generation === undefined ? undefined : String(metadata.generation);
    const out: PutResult = {};
    if (generation) {
      out.etag = generation;
      // Mirror S3: expose a version only when the bucket actually retains versions.
      if (this.versioningSupported) out.version = generation;
    }
    return out;
  }

  private objectMeta(key: string, metadata: FileMetadata): ObjectMeta {
    const generation =
      metadata.generation === undefined ? undefined : String(metadata.generation);
    return {
      key,
      size: Number(metadata.size ?? 0),
      ...(generation ? { etag: generation } : {}),
      ...(generation && this.versioningSupported ? { version: generation } : {}),
      lastModified: metadata.updated ?? new Date(0).toISOString(),
    };
  }
}

/**
 * Construct a {@link GCSObjectStore}, probing the bucket's versioning status.
 * Use this in production wiring; construct {@link GCSObjectStore} directly only when
 * you want to skip the probe (e.g. tests with a known bucket).
 */
export async function createGCSObjectStore(
  opts: GCSObjectStoreOptions,
): Promise<GCSObjectStore> {
  const client = opts.client ?? new Storage(buildClientConfig(opts));
  let versioningSupported = opts.versioningSupported ?? false;
  if (opts.versioningSupported === undefined) {
    try {
      const [metadata] = await client.bucket(opts.bucket).getMetadata();
      versioningSupported = metadata.versioning?.enabled === true;
    } catch {
      // Probe failed (permissions, mocked endpoint) — leave the default.
    }
  }
  return new GCSObjectStore({ ...opts, client, versioningSupported });
}

/** Convenience: create a bucket on a GCS endpoint (used by tests). */
export async function ensureGCSBucket(opts: GCSObjectStoreOptions): Promise<void> {
  const client = opts.client ?? new Storage(buildClientConfig(opts));
  try {
    await client.createBucket(opts.bucket);
  } catch (err) {
    // 409 Conflict — the bucket already exists; ignore.
    if (!isConflict(err)) throw err;
  }
}

/** Build the SDK client config from options (shared by constructor + factory). */
function buildClientConfig(opts: GCSObjectStoreOptions): StorageOptions {
  return {
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
    ...(opts.apiEndpoint ? { apiEndpoint: opts.apiEndpoint } : {}),
    ...(opts.keyFilename ? { keyFilename: opts.keyFilename } : {}),
    ...(opts.credentials
      ? {
          credentials: {
            client_email: opts.credentials.clientEmail,
            private_key: opts.credentials.privateKey,
          },
        }
      : {}),
  };
}

/** HTTP status code of a GCS `ApiError`, if present. */
function statusCode(err: unknown): number | undefined {
  const code = (err as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

function isNotFound(err: unknown): boolean {
  return statusCode(err) === 404;
}

function isPreconditionFailed(err: unknown): boolean {
  return statusCode(err) === 412;
}

function isConflict(err: unknown): boolean {
  return statusCode(err) === 409;
}
