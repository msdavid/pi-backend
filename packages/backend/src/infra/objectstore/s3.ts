/**
 * S3-compatible {@link ObjectStore} (§28) — for SaaS deployments (§3.2).
 *
 * Backed by AWS SDK v3 (`@aws-sdk/client-s3`). Works against any S3-compatible
 * endpoint (AWS S3, MinIO, etc.) via `endpoint` + `forcePathStyle`. Streaming
 * get/put via `GetObject`/`PutObject`. `conditionalPut` uses the S3 `If-Match`
 * header. `list` uses `ListObjectsV2` with `Prefix` + pagination.
 *
 * Versioning: `versioningSupported` is probed at construction time (via
 * `GetBucketVersioning`) when the store is created through {@link createS3ObjectStore}.
 * The probe is best-effort — on failure it falls back to the caller-supplied default.
 *
 * §25.5: credentials are passed only via the constructor options and never logged.
 */

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import type { ObjectMeta, ObjectStore, PutResult } from "../../domain/ports.js";
import type { ObjectStoreProbeResult } from "./filesystem.js";

/** AWS credentials (never logged). */
export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

/** Options for {@link S3ObjectStore} / {@link createS3ObjectStore}. */
export interface S3ObjectStoreOptions {
  /** Bucket name. */
  bucket: string;
  /**
   * S3-compatible endpoint override (e.g. `http://localhost:9000` for MinIO).
   * Omit for AWS S3.
   */
  endpoint?: string;
  /** AWS region. Defaults to `us-east-1`. */
  region?: string;
  /** Credentials. Omit to use the SDK's default credential chain. */
  credentials?: S3Credentials;
  /**
   * Use path-style addressing (`http://endpoint/bucket/key`). Required for MinIO;
   * defaults to `true` when an `endpoint` is provided.
   */
  forcePathStyle?: boolean;
  /** Inject a pre-built client (tests). Bypasses `endpoint`/`credentials`. */
  client?: S3Client;
  /**
   * Override the versioning probe result (tests / known buckets). When omitted,
   * {@link createS3ObjectStore} probes the bucket.
   */
  versioningSupported?: boolean;
}

/**
 * S3-backed {@link ObjectStore}. Construct directly with a known
 * `versioningSupported` value, or via {@link createS3ObjectStore} to probe it.
 */
export class S3ObjectStore implements ObjectStore {
  readonly versioningSupported: boolean;
  readonly bucket: string;
  readonly client: S3Client;

  constructor(opts: S3ObjectStoreOptions) {
    this.bucket = opts.bucket;
    this.client = opts.client ?? new S3Client(buildClientConfig(opts));
    this.versioningSupported = opts.versioningSupported ?? false;
  }

  async put(key: string, stream: ReadableStream<Uint8Array>): Promise<PutResult> {
    const res = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: Readable.fromWeb(stream),
      }),
    );
    return putResult(res.ETag, res.VersionId);
  }

  async get(key: string): Promise<ReadableStream<Uint8Array>> {
    let res;
    try {
      res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (err) {
      if ((err as { name?: string }).name === "NoSuchKey") {
        throw new Error(`object not found: ${key}`);
      }
      throw err;
    }
    if (!res.Body) throw new Error(`object not found: ${key}`);
    // In the Node runtime the SDK returns a Node Readable for `Body`.
    return Readable.toWeb(res.Body as Readable) as ReadableStream<Uint8Array>;
  }

  async conditionalPut(
    key: string,
    stream: ReadableStream<Uint8Array>,
    ifMatch: string,
  ): Promise<PutResult> {
    let res;
    try {
      res = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: Readable.fromWeb(stream),
          IfMatch: ifMatch,
        }),
      );
    } catch (err) {
      const name = (err as { name?: string }).name ?? "";
      // S3 returns 412 PreconditionFailed when If-Match doesn't match.
      if (name.includes("PreconditionFailed") || name.includes("412")) {
        throw new Error(`conditional put failed: etag mismatch (${ifMatch})`);
      }
      throw err;
    }
    return putResult(res.ETag, res.VersionId);
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  /**
   * Purge the object and every version + delete marker (§13.6). A plain
   * `DeleteObjectCommand` on a versioned bucket only appends a delete marker,
   * leaving the prior (plaintext) version retrievable by `VersionId`; here we
   * enumerate all versions of the exact key via `ListObjectVersions` and delete
   * each one by `VersionId`. On a non-versioned bucket the sole version has id
   * `"null"`, so this still hard-deletes the object.
   */
  async hardDelete(key: string): Promise<void> {
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectVersionsCommand({
          Bucket: this.bucket,
          Prefix: key,
          ...(keyMarker ? { KeyMarker: keyMarker } : {}),
          ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
        }),
      );
      for (const entry of [...(res.Versions ?? []), ...(res.DeleteMarkers ?? [])]) {
        // `Prefix` is a prefix match — only purge versions of the exact key.
        if (entry.Key !== key || !entry.VersionId) continue;
        await this.client.send(
          new DeleteObjectCommand({
            Bucket: this.bucket,
            Key: key,
            VersionId: entry.VersionId,
          }),
        );
      }
      keyMarker = res.IsTruncated ? res.NextKeyMarker : undefined;
      versionIdMarker = res.IsTruncated ? res.NextVersionIdMarker : undefined;
    } while (keyMarker || versionIdMarker);
  }

  async head(key: string): Promise<ObjectMeta | null> {
    let res;
    try {
      res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (err) {
      const name = (err as { name?: string }).name ?? "";
      if (name === "NotFound" || name === "NoSuchKey" || name.includes("404")) {
        return null;
      }
      throw err;
    }
    return {
      key,
      size: res.ContentLength ?? 0,
      etag: res.ETag,
      version: res.VersionId,
      lastModified: res.LastModified?.toISOString() ?? new Date(0).toISOString(),
    };
  }

  async *list(prefix: string): AsyncIterable<ObjectMeta> {
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      for (const obj of res.Contents ?? []) {
        if (!obj.Key) continue;
        yield {
          key: obj.Key,
          size: obj.Size ?? 0,
          etag: obj.ETag,
          lastModified: obj.LastModified?.toISOString() ?? new Date(0).toISOString(),
        };
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
  }

  /** Readiness probe: `HeadBucket` against the configured bucket. */
  async probe(): Promise<ObjectStoreProbeResult> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return { status: "up" };
    } catch (err) {
      return {
        status: "down",
        detail: `s3 bucket not reachable: ${(err as Error).message}`,
      };
    }
  }
}

/**
 * Construct an {@link S3ObjectStore}, probing the bucket's versioning status.
 * Use this in production wiring; construct {@link S3ObjectStore} directly only when
 * you want to skip the probe (e.g. tests with a known bucket).
 */
export async function createS3ObjectStore(
  opts: S3ObjectStoreOptions,
): Promise<S3ObjectStore> {
  const client = opts.client ?? new S3Client(buildClientConfig(opts));
  let versioningSupported = opts.versioningSupported ?? false;
  if (opts.versioningSupported === undefined) {
    try {
      const res = await client.send(
        new GetBucketVersioningCommand({ Bucket: opts.bucket }),
      );
      versioningSupported = res.Status === "Enabled";
    } catch {
      // Probe failed (permissions, mocked endpoint) — leave the default.
    }
  }
  return new S3ObjectStore({ ...opts, client, versioningSupported });
}

/** Convenience: create a bucket on an S3-compatible endpoint (used by tests). */
export async function ensureS3Bucket(opts: S3ObjectStoreOptions): Promise<void> {
  const client = opts.client ?? new S3Client(buildClientConfig(opts));
  try {
    await client.send(new CreateBucketCommand({ Bucket: opts.bucket }));
  } catch (err) {
    // BucketAlreadyOwnedByYou / BucketAlreadyExists — ignore.
    const name = (err as { name?: string }).name ?? "";
    if (!name.includes("BucketAlready")) throw err;
  } finally {
    if (!opts.client) client.destroy();
  }
}

/** Build the SDK client config from options (shared by constructor + factory). */
function buildClientConfig(opts: S3ObjectStoreOptions): S3ClientConfig {
  return {
    ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    region: opts.region ?? "us-east-1",
    ...(opts.credentials
      ? {
          credentials: {
            accessKeyId: opts.credentials.accessKeyId,
            secretAccessKey: opts.credentials.secretAccessKey,
          },
        }
      : {}),
    forcePathStyle: opts.forcePathStyle ?? Boolean(opts.endpoint),
  };
}

function putResult(etag?: string, version?: string): PutResult {
  const out: PutResult = {};
  if (etag) out.etag = etag;
  if (version) out.version = version;
  return out;
}
