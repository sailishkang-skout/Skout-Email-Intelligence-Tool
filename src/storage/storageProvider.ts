import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";

import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { config } from "../config/config.js";

/*
==================================================
STORAGE PROVIDER
==================================================

Purpose:

S3-compatible object storage abstraction for large
files/artifacts (CSV imports/exports, generated
reports, large enrichment artifacts) — nothing in
this codebase should store large blobs directly in
PostgreSQL, and nothing should expose a raw
filesystem path to a caller.

Works against real AWS S3 in production and against
MinIO locally (see docker-compose.yml) — both speak
the S3 API, so the same client code runs unmodified
against either.

NOTE ON CURRENT USAGE:

As of this change, no feature in this service
actually produces large files yet (no CSV import/
export, no report generation). This module exists
so that when such a feature is built, it has a
tenant-isolated, size/type-validated storage
boundary to use rather than reaching for the
filesystem or PostgreSQL directly. It is not wired
into any route today — see the completion report for
why building a speculative caller wasn't in scope.
==================================================
*/

export interface UploadOptions {
  tenantId: string;
  key: string;
  body: Buffer | Uint8Array;
  contentType: string;
  metadata?: Record<string, string>;
}

export interface StorageObjectMetadata {
  key: string;
  sizeBytes: number;
  contentType: string | null;
  lastModified: Date | null;
  metadata: Record<string, string>;
}

const ALLOWED_CONTENT_TYPES = new Set([
  "text/csv",
  "application/json",
  "application/pdf",
  "text/plain",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

/**
 * Builds the tenant-scoped object key and rejects anything that
 * could escape the tenant's prefix (path traversal, absolute
 * paths, null bytes) or that isn't a plain, predictable filename.
 */
function buildSafeKey(
  tenantId: string,
  key: string
): string {

  if (!tenantId || !/^[a-zA-Z0-9_-]+$/.test(tenantId)) {
    throw new Error("INVALID_TENANT_ID");
  }

  if (
    !key ||
    key.includes("..") ||
    key.includes("\0") ||
    key.startsWith("/") ||
    !/^[a-zA-Z0-9._/-]+$/.test(key)
  ) {
    throw new Error("INVALID_STORAGE_KEY");
  }

  return `tenants/${tenantId}/${key}`;

}

let client: S3Client | null = null;

function getClient(): S3Client {

  if (!client) {

    client = new S3Client({
      region: config.storage.region,
      endpoint: config.storage.endpoint,
      forcePathStyle: config.storage.forcePathStyle,
      credentials:
        config.storage.accessKeyId && config.storage.secretAccessKey
          ? {
              accessKeyId: config.storage.accessKeyId,
              secretAccessKey: config.storage.secretAccessKey,
            }
          : undefined,
    });

  }

  return client;

}

/**
 * Idempotently ensures the configured bucket exists. Safe to call
 * repeatedly at startup — a no-op if the bucket is already there.
 */
export async function ensureBucketExists(): Promise<void> {

  const s3 = getClient();

  try {

    await s3.send(
      new HeadBucketCommand({ Bucket: config.storage.bucket })
    );

  } catch {

    await s3.send(
      new CreateBucketCommand({ Bucket: config.storage.bucket })
    );

  }

}

export async function uploadObject(
  options: UploadOptions
): Promise<{ key: string }> {

  if (options.body.byteLength > config.storage.maxUploadBytes) {
    throw new Error("STORAGE_FILE_TOO_LARGE");
  }

  if (!ALLOWED_CONTENT_TYPES.has(options.contentType)) {
    throw new Error("STORAGE_CONTENT_TYPE_NOT_ALLOWED");
  }

  const key = buildSafeKey(options.tenantId, options.key);

  await getClient().send(
    new PutObjectCommand({
      Bucket: config.storage.bucket,
      Key: key,
      Body: options.body,
      ContentType: options.contentType,
      Metadata: options.metadata,
    })
  );

  return { key };

}

export async function downloadObject(
  tenantId: string,
  key: string
): Promise<Buffer> {

  const safeKey = buildSafeKey(tenantId, key);

  const result = await getClient().send(
    new GetObjectCommand({
      Bucket: config.storage.bucket,
      Key: safeKey,
    })
  );

  const body = result.Body;

  if (!body) {
    throw new Error("STORAGE_OBJECT_EMPTY");
  }

  const chunks: Buffer[] = [];

  for await (const chunk of body as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);

}

export async function deleteObject(
  tenantId: string,
  key: string
): Promise<void> {

  const safeKey = buildSafeKey(tenantId, key);

  await getClient().send(
    new DeleteObjectCommand({
      Bucket: config.storage.bucket,
      Key: safeKey,
    })
  );

}

export async function objectExists(
  tenantId: string,
  key: string
): Promise<boolean> {

  const safeKey = buildSafeKey(tenantId, key);

  try {

    await getClient().send(
      new HeadObjectCommand({
        Bucket: config.storage.bucket,
        Key: safeKey,
      })
    );

    return true;

  } catch {

    return false;

  }

}

export async function getObjectMetadata(
  tenantId: string,
  key: string
): Promise<StorageObjectMetadata | null> {

  const safeKey = buildSafeKey(tenantId, key);

  try {

    const result = await getClient().send(
      new HeadObjectCommand({
        Bucket: config.storage.bucket,
        Key: safeKey,
      })
    );

    return {
      key,
      sizeBytes: result.ContentLength ?? 0,
      contentType: result.ContentType ?? null,
      lastModified: result.LastModified ?? null,
      metadata: result.Metadata ?? {},
    };

  } catch {

    return null;

  }

}

/**
 * Time-limited, tenant-scoped signed URL for direct client
 * upload/download without proxying the bytes through this service.
 */
export async function getSignedDownloadUrl(
  tenantId: string,
  key: string,
  expiresInSeconds: number = config.storage.signedUrlTtlSeconds
): Promise<string> {

  const safeKey = buildSafeKey(tenantId, key);

  return getSignedUrl(
    getClient(),
    new GetObjectCommand({
      Bucket: config.storage.bucket,
      Key: safeKey,
    }),
    { expiresIn: expiresInSeconds }
  );

}

export async function getSignedUploadUrl(
  tenantId: string,
  key: string,
  contentType: string,
  expiresInSeconds: number = config.storage.signedUrlTtlSeconds
): Promise<string> {

  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new Error("STORAGE_CONTENT_TYPE_NOT_ALLOWED");
  }

  const safeKey = buildSafeKey(tenantId, key);

  return getSignedUrl(
    getClient(),
    new PutObjectCommand({
      Bucket: config.storage.bucket,
      Key: safeKey,
      ContentType: contentType,
    }),
    { expiresIn: expiresInSeconds }
  );

}

export async function pingStorage(): Promise<boolean> {

  try {
    await getClient().send(
      new HeadBucketCommand({ Bucket: config.storage.bucket })
    );
    return true;
  } catch {
    return false;
  }

}
