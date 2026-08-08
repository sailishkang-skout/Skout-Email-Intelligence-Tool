import { test } from "node:test";
import assert from "node:assert/strict";

/*
Runs against the real PostgreSQL instance (see docker-compose.yml).
config.ts already defaults DATABASE_URL to that instance outside of
production, so no environment overrides are needed here — just
Postgres actually running (`docker compose up -d postgres`).
*/

import {
  createVerificationJob,
  getVerificationJob,
  listVerificationJobItems,
  markJobRunning,
  markItemProcessing,
  completeVerificationItem,
  failVerificationItem,
  updateJobProgress,
} from "./verificationJobService.js";

test("verificationJobService: creating a job persists one item per email and dedupes", async () => {
  const job = await createVerificationJob([
    "a@example.com",
    "b@example.com",
    "a@example.com", // duplicate collapses after normalization
  ]);

  assert.equal(job.status, "PENDING");
  assert.equal(job.total, 2);

  const items = await listVerificationJobItems(job.jobId);
  assert.equal(items.length, 2);
});

test("verificationJobService: markJobRunning transitions PENDING -> RUNNING", async () => {
  const job = await createVerificationJob(["running@example.com"]);

  await markJobRunning(job.jobId);

  const updated = await getVerificationJob(job.jobId);
  assert.equal(updated?.status, "RUNNING");
  assert.ok(updated?.started_at);
});

test("verificationJobService: completing every item finalizes the job as COMPLETED", async () => {
  const job = await createVerificationJob([
    "complete-a@example.com",
    "complete-b@example.com",
  ]);

  await markJobRunning(job.jobId);

  const items = await listVerificationJobItems(job.jobId);

  for (const item of items) {
    await markItemProcessing(item.id);
    await completeVerificationItem(item.id, { success: true }, 1);
    await updateJobProgress(job.jobId);
  }

  const finalJob = await getVerificationJob(job.jobId);

  assert.equal(finalJob?.status, "COMPLETED");
  assert.equal(finalJob?.successful, 2);
  assert.equal(finalJob?.processed_emails, 2);
});

test("verificationJobService: a fully-failed job finalizes as FAILED", async () => {
  const job = await createVerificationJob(["fail-only@example.com"]);

  await markJobRunning(job.jobId);

  const [item] = await listVerificationJobItems(job.jobId);

  await markItemProcessing(item.id);
  await failVerificationItem(item.id, new Error("boom"), 3);
  await updateJobProgress(job.jobId);

  const finalJob = await getVerificationJob(job.jobId);

  assert.equal(finalJob?.status, "FAILED");
  assert.equal(finalJob?.failed, 1);
});

test("verificationJobService: a job stays RUNNING until every item reaches a terminal state", async () => {
  const job = await createVerificationJob([
    "partial-a@example.com",
    "partial-b@example.com",
  ]);

  await markJobRunning(job.jobId);

  const [first] = await listVerificationJobItems(job.jobId);

  await markItemProcessing(first.id);
  await completeVerificationItem(first.id, { success: true }, 1);
  await updateJobProgress(job.jobId);

  const stillRunning = await getVerificationJob(job.jobId);

  assert.equal(stillRunning?.status, "RUNNING");
  assert.equal(stillRunning?.processed_emails, 1);
});

test("verificationJobService: mixed success/failure finalizes as COMPLETED (partial success is not a job failure)", async () => {
  const job = await createVerificationJob([
    "mixed-a@example.com",
    "mixed-b@example.com",
  ]);

  await markJobRunning(job.jobId);

  const items = await listVerificationJobItems(job.jobId);

  await markItemProcessing(items[0].id);
  await completeVerificationItem(items[0].id, { success: true }, 1);
  await updateJobProgress(job.jobId);

  await markItemProcessing(items[1].id);
  await failVerificationItem(items[1].id, new Error("smtp timeout"), 3);
  await updateJobProgress(job.jobId);

  const finalJob = await getVerificationJob(job.jobId);

  assert.equal(finalJob?.status, "COMPLETED");
  assert.equal(finalJob?.successful, 1);
  assert.equal(finalJob?.failed, 1);
});

test("verificationJobService: getVerificationJob returns null for an unknown id", async () => {
  const result = await getVerificationJob("00000000-0000-0000-0000-000000000000");
  assert.equal(result, null);
});
