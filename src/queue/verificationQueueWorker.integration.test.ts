import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { Job } from "bullmq";

import type { VerificationJobPayload } from "./verificationQueue.js";

/*
Regression test for a real bug found via a live graceful-shutdown
drill: BullMQ's worker.close() resolves once the active job PROCESSOR
returns, but does NOT wait for the "completed"/"failed" event
LISTENERS (registered separately via worker.on) to finish their own
async work - those listeners are what actually persist completion to
Postgres via completeVerificationItem()/updateJobProgress().

Confirmed live: sending SIGTERM to the worker mid-job let
completeVerificationItem() succeed but killed the Postgres pool before
the very next line, updateJobProgress(), could run. The verification
item itself persisted correctly (status: COMPLETED, real SMTP result),
but the job's aggregate status was left stuck at RUNNING with
processed_emails: 0 forever - even though the underlying error
("Cannot use a pool after calling end on the pool") was logged and
silently swallowed by the handler's own try/catch.

This test reproduces the exact race deterministically: mock
completeVerificationItem/updateJobProgress with an artificial delay,
manually emit a synthetic "completed" event, and assert
waitForPendingHandlers() genuinely blocks until both calls have
finished - which is what worker.ts's shutdown sequence now awaits
before closing Redis/Postgres.
*/

let completeCalled = false;
let updateProgressCalled = false;
let completeResolvedBeforeWait = false;

mock.module("../services/verificationJobService.js", {
  namedExports: {
    markJobRunning: async () => {},
    markItemProcessing: async () => {},
    completeVerificationItem: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      completeCalled = true;
    },
    failVerificationItem: async () => {},
    updateJobProgress: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      updateProgressCalled = true;
      completeResolvedBeforeWait = completeCalled;
    },
    // Both tests in this file drive the worker's "completed" event
    // directly via worker.emit(...) rather than through the real
    // processor, so this value is never actually read by either test -
    // it only needs to exist so the module under test (which imports
    // it at the top level) loads at all. verificationQueueWorker.ts
    // imports every one of these named exports, so every one of them
    // must be present here too, even ones a given test doesn't
    // exercise.
    getVerificationJobItemStatus: async () => "PENDING",
  }
});

import { requireRedis } from "../testHelpers/requireInfra.js";

test.before(() => requireRedis());

const {
  startVerificationQueueWorker,
  JOB_LOCK_DURATION_MS,
  JOB_STALLED_CHECK_INTERVAL_MS,
  JOB_MAX_STALLED_COUNT,
} = await import("./verificationQueueWorker.js");

test("verificationQueueWorker: the Worker is constructed with the intended stall-safety configuration (lockDuration comfortably exceeds worst-case verifyEmail() duration)", async () => {
  const { worker } = startVerificationQueueWorker();

  try {
    assert.equal(worker.opts.lockDuration, JOB_LOCK_DURATION_MS);
    assert.equal(worker.opts.stalledInterval, JOB_STALLED_CHECK_INTERVAL_MS);
    assert.equal(worker.opts.maxStalledCount, JOB_MAX_STALLED_COUNT);

    // The actual safety property this exists for: enough margin that
    // a realistic worst-case verifyEmail() run (~60-65s - see the
    // constant's own doc comment) fits well inside a single lock
    // period without needing to survive more than one renewal cycle.
    assert.ok(
      JOB_LOCK_DURATION_MS >= 65_000 * 1.5,
      "lockDuration must retain generous margin above the real worst-case verification duration"
    );
  } finally {
    await worker.close();
  }
});

test("verificationQueueWorker: waitForPendingHandlers() blocks until the 'completed' event listener's Postgres writes finish", async () => {
  const { worker, waitForPendingHandlers } = startVerificationQueueWorker();

  try {
    const fakeJob = {
      data: { itemId: "test-item-id", jobId: "test-job-id", email: "test@example.com" },
      attemptsMade: 1,
      opts: { attempts: 3 }
    } as unknown as Job<VerificationJobPayload>;

    // Simulates BullMQ emitting "completed" for an in-flight job right
    // as a graceful shutdown begins - before this test's assertions,
    // neither completeVerificationItem() nor updateJobProgress() (both
    // artificially delayed 50ms above) have had a chance to resolve.
    worker.emit("completed", fakeJob, { success: true }, "active");

    assert.equal(
      completeCalled,
      false,
      "sanity check: the handler should still be in flight immediately after emit()"
    );

    await waitForPendingHandlers();

    assert.equal(
      completeCalled,
      true,
      "waitForPendingHandlers() resolved before completeVerificationItem() finished"
    );

    assert.equal(
      updateProgressCalled,
      true,
      "waitForPendingHandlers() resolved before updateJobProgress() finished - this is exactly the race that left a real job stuck at RUNNING forever"
    );

    assert.equal(
      completeResolvedBeforeWait,
      true,
      "updateJobProgress() must only run after completeVerificationItem() has actually finished"
    );
  } finally {
    await worker.close();
  }
});

test("verificationQueueWorker: the 'completed' listener does not re-persist a skipped duplicate-delivery result", async () => {
  const { worker, waitForPendingHandlers } = startVerificationQueueWorker();

  completeCalled = false;
  updateProgressCalled = false;

  try {
    const fakeJob = {
      data: { itemId: "already-terminal-item-id", jobId: "test-job-id", email: "test@example.com" },
      attemptsMade: 1,
      opts: { attempts: 3 }
    } as unknown as Job<VerificationJobPayload>;

    // processVerificationJob() itself never runs a real SMTP check for
    // an already-terminal item - it resolves with this marker instead
    // (see verificationQueueWorker.ts). This asserts the "completed"
    // listener respects that marker rather than blindly persisting it
    // over the item's real, already-saved result.
    worker.emit(
      "completed",
      fakeJob,
      { skipped: true, reason: "already-terminal", status: "COMPLETED" },
      "active"
    );

    await waitForPendingHandlers();

    assert.equal(
      completeCalled,
      false,
      "completeVerificationItem() must not run for a skipped duplicate-delivery result - it would clobber the item's real result_json"
    );

    assert.equal(updateProgressCalled, false);
  } finally {
    await worker.close();
  }
});

test.after(async () => {
  const { closeRedis } = await import("../redis/redisClient.js");
  await closeRedis();
});
