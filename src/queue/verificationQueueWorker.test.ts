import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { Job } from "bullmq";

import type { VerificationJobPayload } from "./verificationQueue.js";

/*
Regression test for the outbox architecture's duplicate-work
requirement: BullMQ redelivery (stalled-job recovery, at-least-once
delivery) or an outbox retry racing an already-successful prior
enqueue must never trigger a second real SMTP verification for an
item that has already reached a terminal state. Confirmed by design
review (see src/queue/outboxDispatcher.ts) that this is the one gap
the transactional outbox itself does not close on its own - BullMQ's
jobId dedup only prevents a duplicate *job*, not a duplicate
*delivery* of the same job.
*/

let getStatusCalls: string[] = [];
let getStatusReturn: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | null = "PENDING";
let markProcessingCalls: string[] = [];
let markRunningCalls: string[] = [];
let verifyEmailCalls: string[] = [];

mock.module("../services/verificationJobService.js", {
  namedExports: {
    getVerificationJobItemStatus: async (itemId: string) => {
      getStatusCalls.push(itemId);
      return getStatusReturn;
    },
    markJobRunning: async (jobId: string) => {
      markRunningCalls.push(jobId);
    },
    markItemProcessing: async (itemId: string) => {
      markProcessingCalls.push(itemId);
    },
    // Unused by processVerificationJob() itself, but the module under
    // test imports all four at the top level - every named export it
    // imports must be present here too, even ones this file's tests
    // never exercise directly.
    completeVerificationItem: async () => {},
    failVerificationItem: async () => {},
    updateJobProgress: async () => {},
  },
});

mock.module("../services/emailVerificationOrchestrator.js", {
  namedExports: {
    verifyEmail: async (email: string) => {
      verifyEmailCalls.push(email);
      return { verificationStatus: "VALID" };
    },
  },
});

const { processVerificationJob } = await import("./verificationQueueWorker.js");

function fakeJob(itemId: string, email: string): Job<VerificationJobPayload> {
  return {
    data: { itemId, jobId: "job-1", email },
  } as unknown as Job<VerificationJobPayload>;
}

test.beforeEach(() => {
  getStatusCalls = [];
  markProcessingCalls = [];
  markRunningCalls = [];
  verifyEmailCalls = [];
});

test("processVerificationJob: skips verifyEmail when the item is already COMPLETED", async () => {
  getStatusReturn = "COMPLETED";

  const result = await processVerificationJob(fakeJob("item-1", "a@example.com"));

  assert.deepEqual(result, {
    skipped: true,
    reason: "already-terminal",
    status: "COMPLETED",
  });

  assert.equal(verifyEmailCalls.length, 0, "verifyEmail must not run for an already-completed item");
  assert.equal(markProcessingCalls.length, 0, "markItemProcessing must not run for a skipped item");
  assert.equal(markRunningCalls.length, 0, "markJobRunning must not run for a skipped item either");
});

test("processVerificationJob: skips verifyEmail when the item is already FAILED", async () => {
  getStatusReturn = "FAILED";

  const result = await processVerificationJob(fakeJob("item-2", "b@example.com"));

  assert.deepEqual(result, {
    skipped: true,
    reason: "already-terminal",
    status: "FAILED",
  });

  assert.equal(verifyEmailCalls.length, 0);
});

test("processVerificationJob: runs verifyEmail normally when the item is PENDING, and marks the job RUNNING", async () => {
  getStatusReturn = "PENDING";

  await processVerificationJob(fakeJob("item-3", "c@example.com"));

  assert.deepEqual(verifyEmailCalls, ["c@example.com"]);
  assert.deepEqual(markProcessingCalls, ["item-3"]);
  assert.deepEqual(markRunningCalls, ["job-1"], "the job must transition to RUNNING once real processing starts");
});

test("processVerificationJob: runs verifyEmail normally when the item is PROCESSING (legitimate in-flight retry, not a duplicate)", async () => {
  getStatusReturn = "PROCESSING";

  await processVerificationJob(fakeJob("item-4", "d@example.com"));

  assert.deepEqual(
    verifyEmailCalls,
    ["d@example.com"],
    "a stalled-job recovery retry for an item that never reached a terminal state must still run"
  );
});
