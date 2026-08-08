import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

/*
Runs against the real MinIO instance (see docker-compose.yml).
config.ts already defaults STORAGE_ENDPOINT/credentials to that
instance outside of production.
*/

import {
  ensureBucketExists,
  uploadObject,
  downloadObject,
  deleteObject,
  objectExists,
  getObjectMetadata,
  getSignedDownloadUrl,
} from "./storageProvider.js";

const tenantId = "test-tenant";

test.before(async () => {
  await ensureBucketExists();
});

test("storageProvider: upload then download round-trips the exact bytes", async () => {
  const key = `uploads/${randomUUID()}.csv`;
  const body = Buffer.from("email,status\na@example.com,VERIFIED\n");

  await uploadObject({
    tenantId,
    key,
    body,
    contentType: "text/csv",
  });

  const downloaded = await downloadObject(tenantId, key);

  assert.equal(downloaded.toString("utf8"), body.toString("utf8"));

  await deleteObject(tenantId, key);
});

test("storageProvider: objectExists reflects upload and delete", async () => {
  const key = `uploads/${randomUUID()}.csv`;

  assert.equal(await objectExists(tenantId, key), false);

  await uploadObject({
    tenantId,
    key,
    body: Buffer.from("test"),
    contentType: "text/csv",
  });

  assert.equal(await objectExists(tenantId, key), true);

  await deleteObject(tenantId, key);

  assert.equal(await objectExists(tenantId, key), false);
});

test("storageProvider: rejects content types outside the allow-list", async () => {
  await assert.rejects(
    () =>
      uploadObject({
        tenantId,
        key: `uploads/${randomUUID()}.exe`,
        body: Buffer.from("test"),
        contentType: "application/x-msdownload",
      }),
    /STORAGE_CONTENT_TYPE_NOT_ALLOWED/
  );
});

test("storageProvider: rejects path traversal in the object key", async () => {
  await assert.rejects(
    () =>
      uploadObject({
        tenantId,
        key: "../../etc/passwd",
        body: Buffer.from("test"),
        contentType: "text/csv",
      }),
    /INVALID_STORAGE_KEY/
  );
});

test("storageProvider: rejects an unsafe tenant id (tenant isolation boundary)", async () => {
  await assert.rejects(
    () =>
      uploadObject({
        tenantId: "../other-tenant",
        key: "uploads/file.csv",
        body: Buffer.from("test"),
        contentType: "text/csv",
      }),
    /INVALID_TENANT_ID/
  );
});

test("storageProvider: getObjectMetadata reports size and content type", async () => {
  const key = `uploads/${randomUUID()}.csv`;
  const body = Buffer.from("hello world");

  await uploadObject({
    tenantId,
    key,
    body,
    contentType: "text/csv",
  });

  const metadata = await getObjectMetadata(tenantId, key);

  assert.ok(metadata);
  assert.equal(metadata?.sizeBytes, body.byteLength);
  assert.equal(metadata?.contentType, "text/csv");

  await deleteObject(tenantId, key);
});

test("storageProvider: a signed download URL is a well-formed, time-limited URL", async () => {
  const key = `uploads/${randomUUID()}.csv`;

  await uploadObject({
    tenantId,
    key,
    body: Buffer.from("test"),
    contentType: "text/csv",
  });

  const url = await getSignedDownloadUrl(tenantId, key, 60);

  assert.match(url, /^https?:\/\//);
  assert.match(url, /X-Amz-Expires=60/);

  await deleteObject(tenantId, key);
});
