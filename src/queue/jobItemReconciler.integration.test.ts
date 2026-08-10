import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";

import { config } from "../config/config.js";

/*
True end-to-end integration test: real Postgres AND real Redis/BullMQ,
no mocking of verificationJobService.js or the repositories. Proves
the reconciler added to close a confirmed BullMQ/Postgres consistency
gap (see the STALE PROCESSING ITEM RECOVERY doc comment in
verificationJobService.ts and jobItemReconciler.ts) actually works
against real infrastructure: a worker process killed between BullMQ
recording a job's completed/failed outcome and our own event
listener's Postgres write finishing leaves verification_job_items
stuck at PROCESSING forever, since BullMQ never redelivers a job it
already considers terminal.

Uses its OWN dedicated queue name and Redis connection, matching the
established pattern in outboxFullLifecycle.integration.test.ts - this
test starts real BullMQ Worker instances, and sharing the production
"verification" queue name risks another integration test file's
worker consuming a job meant for this file (confirmed live there).
*/

const TEST_QUEUE_NAME = `verification-test-${randomUUID()}`;

let dedicatedConnection: Redis | null = null;

function getDedicatedConnection(): Redis {
  if (!dedicatedConnection) {
    dedicatedConnection = new Redis(config.redis.url, { maxRetriesPerRequest: null });
  }
  return dedicatedConnection;
}

let testQueue: Queue | null = null;

function getTestQueue(): Queue {
  if (!testQueue) {
    testQueue = new Queue(TEST_QUEUE_NAME, { connection: getDedicatedConnection() });
  }
  return testQueue;
}

mock.module("./verificationQueue.js", {
  namedExports: {
    VERIFICATION_QUEUE_NAME: TEST_QUEUE_NAME,
    getVerificationQueue: getTestQueue,
  },
});

import { requirePostgres, requireRedis } from "../testHelpers/requireInfra.js";

test.before(async () => {
  await requirePostgres();
  await requireRedis();
});

const {
  createVerificationJob,
  listVerificationJobItems,
  getVerificationJob,
  completeVerificationItem,
  failVerificationItem,
} = await import("../services/verificationJobService.js");

const { reconcileStaleProcessingItemsBatch } = await import("./jobItemReconciler.js");

const { VerificationRepository } = await import("../repositories/verificationRepository.js");
const { createVerificationDecision } = await import(
  "../repositories/verificationDecisionRepository.js"
);
const { getDatabase } = await import("../database/database.js");

const verificationRepository = new VerificationRepository();

/**
 * Simulates the exact stuck state this reconciler exists to fix: a
 * worker process that crashed after markItemProcessing() ran but
 * before its "completed"/"failed" listener persisted the outcome.
 * `agoMs` backdates processing_started_at so the item qualifies (or
 * deliberately does not qualify) as stale.
 */
async function forceItemProcessing(itemId: string, agoMs: number): Promise<void> {
  const db = getDatabase();
  await db.query(
    `
    UPDATE verification_job_items
    SET status = 'PROCESSING', processing_started_at = NOW() - ($2 || ' milliseconds')::interval
    WHERE id = $1
    `,
    [itemId, agoMs]
  );
}

async function getItemStatus(itemId: string): Promise<string | null> {
  const db = getDatabase();
  const result = await db.query<{ status: string }>(
    `SELECT status FROM verification_job_items WHERE id = $1`,
    [itemId]
  );
  return result.rows[0]?.status ?? null;
}

const STALE_MS = 6 * 60_000; // safely past the reconciler's 5-minute threshold
const FRESH_MS = 5_000; // nowhere close to stale

/*
claimStaleProcessingItems() claims oldest-processing_started_at-first,
BATCH_SIZE-limited per call (see jobItemReconciler.ts) - correct
production behavior, but this shared Postgres instance can carry
older stale rows from other test runs. Polling drains however many
batches of backlog sit ahead of this test's own item instead of
assuming a single reconcileStaleProcessingItemsBatch() call reaches
it - the same reasoning already applied to outboxDispatcher.integration.test.ts.
*/
async function pollUntilResolved(itemId: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await reconcileStaleProcessingItemsBatch();
    const status = await getItemStatus(itemId);
    if (status === "COMPLETED" || status === "FAILED") {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`pollUntilResolved: item ${itemId} not resolved within ${timeoutMs}ms (still ${status})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("jobItemReconciler: recovers a stale PROCESSING item directly from an already-persisted result - no re-verification, no BullMQ interaction", async () => {
  const job = await createVerificationJob([`reconciler-recover-${randomUUID()}@example.com`]);
  const [item] = await listVerificationJobItems(job.jobId);

  await forceItemProcessing(item.id, STALE_MS);

  // The work genuinely finished and committed (see the result/decision
  // transaction fix in emailVerificationOrchestrator.ts) - only the
  // job-item's own status update was lost to the simulated crash.
  await verificationRepository.save({
    verificationId: item.id,
    email: job.jobId + "@example.com",
    domain: "example.com",
    verificationStatus: "VERIFIED",
    decision: "SAFE_TO_SEND",
    confidenceScore: 0.95,
    confidenceLevel: "HIGH",
  });

  await createVerificationDecision({
    verificationId: item.id,
    email: "reconciler-recover@example.com",
    decision: "SAFE_TO_SEND",
    verificationStatus: "VERIFIED",
    confidenceScore: 0.95,
    confidenceLevel: "HIGH",
    reasonCodes: ["SAFE_TO_SEND", "VERIFIED"],
    evidenceSnapshot: { smtp: { smtpValid: true } },
    engineVersion: "verification-engine-v1",
  });

  await pollUntilResolved(item.id);

  const status = await getItemStatus(item.id);
  assert.equal(status, "COMPLETED");

  const [reloadedItem] = await listVerificationJobItems(job.jobId);
  const resultJson = reloadedItem.result_json as Record<string, unknown>;
  assert.equal(resultJson.reconciled, true);
  assert.equal(resultJson.verificationStatus, "VERIFIED");
  assert.equal(resultJson.decision, "SAFE_TO_SEND");

  // No duplicate rows - reconciliation only ever READS verification_results/
  // verification_decisions, never writes to them.
  const db = getDatabase();
  const resultCount = await db.query(
    `SELECT COUNT(*)::int AS count FROM verification_results WHERE verification_id = $1`,
    [item.id]
  );
  assert.equal(resultCount.rows[0].count, 1);

  const decisionCount = await db.query(
    `SELECT COUNT(*)::int AS count FROM verification_decisions WHERE verification_id = $1`,
    [item.id]
  );
  assert.equal(decisionCount.rows[0].count, 1);

  // No BullMQ interaction at all for this item - proves zero duplicate
  // SMTP verification risk for the recovered-from-persisted-result path.
  const bullmqJob = await getTestQueue().getJob(item.id);
  assert.equal(bullmqJob, undefined);

  const refreshedJob = await getVerificationJob(job.jobId);
  assert.equal(refreshedJob?.status, "COMPLETED");
});

test("jobItemReconciler: marks a stale PROCESSING item FAILED when BullMQ confirms the underlying job exhausted its retries", async () => {
  const job = await createVerificationJob([`reconciler-failed-${randomUUID()}@example.com`]);
  const [item] = await listVerificationJobItems(job.jobId);

  await forceItemProcessing(item.id, STALE_MS);

  // No persisted verification_results row - the crash happened before
  // any commit. Force the underlying BullMQ job to genuinely fail
  // (attempts: 1, an always-throwing processor) using a real, isolated
  // worker - proving the reconciler asks BullMQ itself, not a guess.
  await getTestQueue().add(
    "verify-email",
    { itemId: item.id, jobId: job.jobId, email: "reconciler-failed@example.com" },
    { jobId: item.id, attempts: 1 }
  );

  const failingWorker = new Worker(
    TEST_QUEUE_NAME,
    async () => {
      throw new Error("simulated permanent SMTP/verification failure");
    },
    { connection: getDedicatedConnection(), concurrency: 1 }
  );

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for the test job to fail")), 15_000);

    failingWorker.on("failed", (failedJob) => {
      if (failedJob?.id === item.id) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });

  await failingWorker.close();

  await pollUntilResolved(item.id);

  const status = await getItemStatus(item.id);
  assert.equal(status, "FAILED");

  const [reloadedItem] = await listVerificationJobItems(job.jobId);
  assert.match(
    reloadedItem.last_error ?? "",
    /simulated permanent SMTP\/verification failure|BullMQ exhausted all retry attempts/
  );

  // No verification_results/verification_decisions rows should exist -
  // this item never actually completed a real verification.
  const db = getDatabase();
  const resultCount = await db.query(
    `SELECT COUNT(*)::int AS count FROM verification_results WHERE verification_id = $1`,
    [item.id]
  );
  assert.equal(resultCount.rows[0].count, 0);
});

test("jobItemReconciler: does not touch an item that has not been PROCESSING long enough (genuinely still in flight)", async () => {
  const job = await createVerificationJob([`reconciler-fresh-${randomUUID()}@example.com`]);
  const [item] = await listVerificationJobItems(job.jobId);

  await forceItemProcessing(item.id, FRESH_MS);

  await reconcileStaleProcessingItemsBatch();

  const status = await getItemStatus(item.id);
  assert.equal(
    status,
    "PROCESSING",
    "an item that has been processing for only a few seconds must never be treated as stuck"
  );
});

test("jobItemReconciler: does not touch a stale item whose BullMQ job is still active/waiting - not actually stuck", async () => {
  const job = await createVerificationJob([`reconciler-active-${randomUUID()}@example.com`]);
  const [item] = await listVerificationJobItems(job.jobId);

  await forceItemProcessing(item.id, STALE_MS);

  // Added but deliberately never consumed - stays "waiting" in BullMQ,
  // which must never be treated as stuck even though Postgres alone
  // would look identical to the genuinely-stuck case.
  await getTestQueue().add(
    "verify-email",
    { itemId: item.id, jobId: job.jobId, email: "reconciler-active@example.com" },
    { jobId: item.id }
  );

  await reconcileStaleProcessingItemsBatch();

  const status = await getItemStatus(item.id);
  assert.equal(status, "PROCESSING");
});

test("jobItemReconciler: leaves an item untouched (not silently flipped) when no persisted result and no BullMQ job exist at all", async () => {
  const job = await createVerificationJob([`reconciler-unresolved-${randomUUID()}@example.com`]);
  const [item] = await listVerificationJobItems(job.jobId);

  await forceItemProcessing(item.id, STALE_MS);

  const result = await reconcileStaleProcessingItemsBatch();

  assert.ok(result.unresolved >= 1);

  const status = await getItemStatus(item.id);
  assert.equal(
    status,
    "PROCESSING",
    "an unexplainable stuck item must be left visible (still PROCESSING) for manual investigation, never silently marked COMPLETED or FAILED"
  );
});

test("jobItemReconciler: an unresolved item's processing_started_at is pushed forward so it stops permanently occupying the front of the claim queue", async () => {
  // Regression test for a real starvation bug found by this very test
  // suite: claimStaleProcessingItems() claims oldest-processing_started_at
  // -first, BATCH_SIZE-limited. An "unresolved" item (see jobItemReconciler.ts)
  // is left at PROCESSING with its timestamp untouched by definition -
  // without touchUnresolvedStaleItem(), it would stay the oldest stale
  // row forever, get reclaimed on every single poll, and (once enough
  // such items accumulate) permanently starve genuinely-recoverable
  // newer stale items out of ever reaching a claim batch.
  const job = await createVerificationJob([`reconciler-unresolved-nudge-${randomUUID()}@example.com`]);
  const [item] = await listVerificationJobItems(job.jobId);

  await forceItemProcessing(item.id, STALE_MS);

  const db = getDatabase();
  const before = await db.query<{ processing_started_at: Date }>(
    `SELECT processing_started_at FROM verification_job_items WHERE id = $1`,
    [item.id]
  );

  const result = await reconcileStaleProcessingItemsBatch();
  assert.ok(result.unresolved >= 1);

  const after = await db.query<{ processing_started_at: Date; status: string }>(
    `SELECT processing_started_at, status FROM verification_job_items WHERE id = $1`,
    [item.id]
  );

  assert.equal(after.rows[0]?.status, "PROCESSING", "still not silently resolved");
  assert.ok(
    after.rows[0].processing_started_at.getTime() > before.rows[0].processing_started_at.getTime(),
    "an unresolved item's processing_started_at must move forward so it doesn't permanently block the front of the oldest-first claim queue"
  );

  // Immediately re-running the batch must NOT re-claim this item - the
  // nudge (threshold/2) leaves it younger than the staleness threshold,
  // so it drops out of eligibility rather than looping on the same
  // unresolved item forever.
  await reconcileStaleProcessingItemsBatch();

  const afterSecondPass = await db.query<{ processing_started_at: Date }>(
    `SELECT processing_started_at FROM verification_job_items WHERE id = $1`,
    [item.id]
  );

  assert.equal(
    afterSecondPass.rows[0]?.processing_started_at.getTime(),
    after.rows[0]?.processing_started_at.getTime(),
    "a second immediate pass must not re-claim (and re-nudge) an item that was just pushed below the staleness threshold"
  );
});

test("jobItemReconciler: an already-COMPLETED item is never claimed/touched, even with an old processing_started_at", async () => {
  const job = await createVerificationJob([`reconciler-already-done-${randomUUID()}@example.com`]);
  const [item] = await listVerificationJobItems(job.jobId);

  await forceItemProcessing(item.id, STALE_MS);
  await completeVerificationItem(item.id, { success: true, real: true }, 1);

  await reconcileStaleProcessingItemsBatch();

  const [reloadedItem] = await listVerificationJobItems(job.jobId);
  assert.equal(reloadedItem.status, "COMPLETED");
  assert.deepEqual(reloadedItem.result_json, { success: true, real: true });
});

test("jobItemReconciler: an already-FAILED item is never claimed/touched, even with an old processing_started_at", async () => {
  const job = await createVerificationJob([`reconciler-already-failed-${randomUUID()}@example.com`]);
  const [item] = await listVerificationJobItems(job.jobId);

  await forceItemProcessing(item.id, STALE_MS);
  await failVerificationItem(item.id, new Error("genuine original failure"), 3);

  await reconcileStaleProcessingItemsBatch();

  const [reloadedItem] = await listVerificationJobItems(job.jobId);
  assert.equal(reloadedItem.status, "FAILED");
  assert.equal(reloadedItem.last_error, "genuine original failure");
});

test("jobItemReconciler: concurrent claims from two callers never claim the same stale item (FOR UPDATE SKIP LOCKED)", async () => {
  const { claimStaleProcessingItems, rollbackProcessingItemsClaim } = await import(
    "../services/verificationJobService.js"
  );

  const job = await createVerificationJob([
    `reconciler-concurrent-a-${randomUUID()}@example.com`,
    `reconciler-concurrent-b-${randomUUID()}@example.com`,
  ]);
  const items = await listVerificationJobItems(job.jobId);

  for (const item of items) {
    await forceItemProcessing(item.id, STALE_MS);
  }

  const [claimA, claimB] = await Promise.all([
    claimStaleProcessingItems(50, 5 * 60_000),
    claimStaleProcessingItems(50, 5 * 60_000),
  ]);

  const idsA = new Set(claimA.rows.map((row) => row.id));
  const idsB = new Set(claimB.rows.map((row) => row.id));

  const overlap = [...idsA].filter((id) => idsB.has(id));

  assert.deepEqual(overlap, [], "two concurrent claims must never select the same row");

  // This test's own two items must both have been claimed by exactly
  // one of the two concurrent callers, combined.
  const thisTestsIds = new Set(items.map((item) => item.id));
  const claimedEither = new Set([...idsA, ...idsB]);
  for (const id of thisTestsIds) {
    assert.ok(claimedEither.has(id), `item ${id} was not claimed by either concurrent caller`);
  }

  await rollbackProcessingItemsClaim(claimA.client);
  await rollbackProcessingItemsClaim(claimB.client);
});

test.after(async () => {
  const { closeDatabase } = await import("../database/database.js");
  const { closeRedis } = await import("../redis/redisClient.js");

  // Several tests above (the "not actually stuck" and "unresolved"
  // cases) deliberately leave a job_item at PROCESSING forever - that
  // is what they assert. Left uncleaned, those rows accumulate across
  // every test run and permanently occupy the front of
  // claimStaleProcessingItems()'s oldest-first ordering (empirically
  // confirmed: this starved a later run's own genuinely-recoverable
  // items out of a single claim batch). Deleting this file's own
  // fixtures (scoped by its own email prefix) keeps the shared
  // Postgres instance from accumulating an ever-growing backlog of
  // rows nothing will ever resolve.
  const db = getDatabase();
  await db.query(`DELETE FROM verification_job_items WHERE email LIKE 'reconciler-%'`);
  await db.query(
    `DELETE FROM verification_jobs WHERE id NOT IN (SELECT DISTINCT job_id FROM verification_job_items)`
  );

  if (testQueue) {
    await testQueue.close();
  }

  if (dedicatedConnection) {
    await dedicatedConnection.quit();
  }

  await closeRedis();
  await closeDatabase();
});
