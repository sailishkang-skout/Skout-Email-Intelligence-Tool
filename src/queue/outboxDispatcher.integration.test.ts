import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

/*
True end-to-end integration test: real PostgreSQL AND real
Redis/BullMQ, no mocking at all. This is what proves the dispatcher's
claim -> enqueueVerificationItem() -> mark-dispatched path actually
works against real infrastructure, not just against the fakes in
outboxDispatcher.test.ts (which cover the Redis-outage/backoff/
crash-safety control flow in isolation, since deterministically
simulating an outage against a real Redis container isn't practical
in an automated test).

Deliberately does NOT start a real BullMQ Worker or exercise the
outbox exhaustion/recovery lifecycle here - both use the REAL, shared
"verification" queue name (correct for THESE two tests, which verify
against real production queue behavior), and Node's test runner runs
multiple integration test files concurrently. A worker started here
would risk racing against another file's own worker on that same
shared queue (confirmed live: this happened when a recovery-lifecycle
test was first added here). See
outboxFullLifecycle.integration.test.ts for the worker-based full
end-to-end lifecycle tests - that file uses a uniquely-generated,
isolated queue name specifically so it can start a real worker
without that risk.
*/

import { requirePostgres, requireRedis } from "../testHelpers/requireInfra.js";

test.before(async () => {
  await requirePostgres();
  await requireRedis();
});

const { createVerificationJob, listVerificationJobItems } = await import(
  "../services/verificationJobService.js"
);

const { dispatchPendingOutboxBatch } = await import("./outboxDispatcher.js");
const { getVerificationQueue } = await import("./verificationQueue.js");
const { getDatabase } = await import("../database/database.js");

/*
The dispatcher claims oldest-pending-first, un-scoped (correct
production behavior), and this shared Postgres instance accumulates
PENDING outbox rows left behind by other integration test files/runs
(see outboxFullLifecycle.integration.test.ts's own pollUntil for the
same reasoning) - so this test's own row is not guaranteed to be
inside a single BATCH_SIZE-limited dispatchPendingOutboxBatch() call.
Polling (bounded by a wall-clock deadline, not a fixed attempt count)
drains however many batches of backlog sit ahead of it instead of
assuming single-batch success.
*/
async function pollUntil(
  predicate: () => Promise<boolean>,
  { timeoutMs = 60_000, delayMs = 20 } = {}
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`pollUntil: condition not met within ${timeoutMs}ms`);
    }
    await dispatchPendingOutboxBatch();
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

test("outboxDispatcher (real Postgres + real Redis): dispatches a pending outbox row into real BullMQ and marks it DISPATCHED", async () => {
  const job = await createVerificationJob([`dispatch-real-${randomUUID()}@example.com`]);
  const [item] = await listVerificationJobItems(job.jobId);

  const db = getDatabase();

  await pollUntil(async () => {
    const row = await db.query<{ status: string }>(
      `SELECT status FROM verification_outbox WHERE job_id = $1`,
      [job.jobId]
    );
    return row.rows[0]?.status === "DISPATCHED";
  });

  const row = await db.query<{ status: string; dispatched_at: Date | null }>(
    `SELECT status, dispatched_at FROM verification_outbox WHERE job_id = $1`,
    [job.jobId]
  );

  assert.equal(row.rows[0]?.status, "DISPATCHED");
  assert.ok(row.rows[0]?.dispatched_at);

  const bullJob = await getVerificationQueue().getJob(item.id);
  assert.ok(bullJob, "a real BullMQ job with jobId = itemId must now exist");
  assert.equal(bullJob?.data.email, item.email);
});

test("outboxDispatcher (real Postgres + real Redis): re-dispatching an already-dispatched item's jobId is a safe BullMQ no-op, not a duplicate job", async () => {
  const job = await createVerificationJob([`dispatch-idempotent-${randomUUID()}@example.com`]);
  const [item] = await listVerificationJobItems(job.jobId);

  const queue = getVerificationQueue();

  await pollUntil(async () => Boolean(await queue.getJob(item.id)));

  const before = await queue.getJob(item.id);
  assert.ok(before);

  // Simulates a dispatcher retry re-attempting an enqueue whose
  // underlying add() already went through once (e.g. after a
  // dispatcher crash between enqueue succeeding and the outbox row
  // being marked DISPATCHED) - re-adding the same jobId must not
  // create a second job.
  await queue.add("verify-email", { itemId: item.id, jobId: job.jobId, email: item.email }, { jobId: item.id });

  const after = await queue.getJob(item.id);
  assert.equal(after?.id, before?.id, "re-adding the same jobId must resolve to the same underlying BullMQ job");
});

test.after(async () => {
  const { closeDatabase } = await import("../database/database.js");
  const { closeRedis } = await import("../redis/redisClient.js");
  const { closeVerificationQueue } = await import("./verificationQueue.js");
  await closeVerificationQueue();
  await closeRedis();
  await closeDatabase();
});
