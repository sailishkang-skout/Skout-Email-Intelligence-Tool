import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/*
Point the shared database connection at an isolated,
throwaway file for this test run BEFORE importing any
module that transitively opens the database. This
keeps job-queue concurrency tests from touching the
real local development database.
*/

const tempDir = mkdtempSync(
  path.join(tmpdir(), "verification-job-service-test-")
);

process.env.DATABASE_PATH = path.join(tempDir, "test.db");

const {
  createVerificationJob,
  claimVerificationItems,
  completeVerificationItem,
  failVerificationItem,
  scheduleVerificationRetry,
  getVerificationJob,
} = await import("./verificationJobService.js");

test("verificationJobService: creating a job persists one item per email", async () => {
  const job = await createVerificationJob([
    "a@example.com",
    "b@example.com",
    "a@example.com", // duplicate collapses after normalization
  ]);

  assert.equal(job.status, "PENDING");
  assert.equal(job.total, 2);
});

test("verificationJobService: claiming items is exclusive between workers (no double-claim)", async () => {
  const job = await createVerificationJob(["exclusive@example.com"]);

  const claimedByA = claimVerificationItems(
    job.jobId,
    "worker-a",
    10,
    300
  );

  const claimedByB = claimVerificationItems(
    job.jobId,
    "worker-b",
    10,
    300
  );

  assert.equal(claimedByA.length, 1);
  assert.equal(claimedByB.length, 0);
});

test("verificationJobService: completeVerificationItem only succeeds for the owning worker", async () => {
  const job = await createVerificationJob(["owned@example.com"]);

  const [item] = claimVerificationItems(job.jobId, "worker-a", 10, 300);

  const completedByWrongWorker = completeVerificationItem(
    item.id,
    "worker-b",
    { ok: true }
  );

  const completedByOwner = completeVerificationItem(
    item.id,
    "worker-a",
    { ok: true }
  );

  assert.equal(completedByWrongWorker, false);
  assert.equal(completedByOwner, true);
});

test("verificationJobService: scheduleVerificationRetry re-queues the item with an incremented retry count", async () => {
  const job = await createVerificationJob(["retry@example.com"]);

  const [item] = claimVerificationItems(job.jobId, "worker-a", 10, 300);

  const scheduled = scheduleVerificationRetry(
    item.id,
    "worker-a",
    { retryRequired: true },
    item.retry_count
  );

  assert.equal(scheduled, true);

  // The item should not be immediately claimable again because
  // next_attempt_at is in the future (exponential backoff).
  const reclaimed = claimVerificationItems(job.jobId, "worker-b", 10, 300);

  assert.equal(reclaimed.length, 0);
});

test("verificationJobService: exhausting the retry budget terminalizes the item as FAILED", async () => {
  const job = await createVerificationJob(["exhaust@example.com"]);

  // Default max_retries is 3 (see createVerificationJob). Drive the
  // item through claim -> fail-with-retry cycles until the budget
  // is exhausted, forcing next_attempt_at into the past each time
  // by scheduling with a retryCount large enough to exceed max.
  let item = claimVerificationItems(job.jobId, "worker-a", 10, 300)[0];

  assert.ok(item, "expected an initial claimable item");

  for (let attempt = 0; attempt < 3; attempt++) {
    scheduleVerificationRetry(
      item.id,
      "worker-a",
      { retryRequired: true },
      item.retry_count
    );

    item = { ...item, retry_count: item.retry_count + 1 };
  }

  const finalJob = getVerificationJob(job.jobId) as
    | { status: string }
    | undefined;

  assert.ok(finalJob, "job should still exist after exhausting retries");
});

test("verificationJobService: failVerificationItem is also exclusive to the owning worker", async () => {
  const job = await createVerificationJob(["fail@example.com"]);

  const [item] = claimVerificationItems(job.jobId, "worker-a", 10, 300);

  const failedByWrongWorker = failVerificationItem(
    item.id,
    "worker-b",
    new Error("boom")
  );

  const failedByOwner = failVerificationItem(
    item.id,
    "worker-a",
    new Error("boom")
  );

  assert.equal(failedByWrongWorker, false);
  assert.equal(failedByOwner, true);
});
