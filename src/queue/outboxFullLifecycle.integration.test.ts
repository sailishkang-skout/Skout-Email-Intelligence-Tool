import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";

/*
End-to-end regression test for the EXACT failure this architecture
replaced: Redis was unavailable when a batch was submitted, and the
API lied about it (HTTP 500 while the job silently succeeded later -
see the redis-outage-test@example.com incident this whole outbox
migration was built to fix). A real Redis outage can't be
deterministically triggered inside an automated test, so this
simulates it via a controlled enqueueVerificationItem failure/recovery
- everything else (Postgres, BullMQ, the real worker, the real
duplicate-processing guard) is real. See the final report for the
actual Docker `docker compose stop redis` / `start redis` drill that
validates this same lifecycle against real infrastructure.

Full lifecycle asserted end-to-end:
  outbox PENDING (job durably accepted, Redis never touched at
  request time) -> dispatcher retries, still fails ("Redis down") ->
  "Redis recovers" -> dispatcher succeeds -> outbox DISPATCHED -> real
  BullMQ job enqueued -> real worker picks it up -> item COMPLETED,
  job COMPLETED - with verifyEmail() called EXACTLY ONCE, proving no
  duplicate SMTP verification happened despite the earlier failed
  attempts.
*/

/*
Uses its OWN dedicated queue name rather than the real
"verification" queue name. This test starts a genuine BullMQ Worker
against real Redis - if it shared the production queue name,
another integration test file's worker (Node's test runner isolates
files into separate processes, but they all share the same real
Redis) could win the race to consume this test's job first,
completing it via that OTHER file's own real/mocked verifyEmail
instead of this file's. Confirmed live: without this, the item
reached COMPLETED but this file's own verifyEmailCalls stayed empty
- verificationQueueWorker.integration.test.ts's worker (also
subscribed to "verification", also live during this test's run) had
consumed the job instead. A unique queue name per test run makes
this test genuinely isolated, matching what an integration test
should guarantee regardless of what else happens to be running.
*/
const TEST_QUEUE_NAME = `verification-test-${randomUUID()}`;

/*
The dispatcher claims oldest-pending-first, un-scoped (correct
production behavior) - this test's own row can share a claimed batch
with unrelated, permanently-PENDING outbox rows left behind by OTHER
integration test files (see pollUntil's doc comment above). Every one
of them gets routed through this same mock. Scoping the simulated
failure to THIS test's own itemId - rather than a call-order counter
- means unrelated rows always dispatch for real (harmless, and it
helps drain the shared backlog) while only the item this test cares
about is deliberately failed twice before succeeding.
*/
let targetItemId: string | null = null;
let failuresRemaining = 2;
let enqueueAttempts = 0;
let realQueue: Queue | null = null;

import { Redis } from "ioredis";
import { config } from "../config/config.js";

/*
Deliberately its OWN Redis connection, NOT the shared
getBullMQConnection() singleton also used by the real Worker this
test starts below. In production the API's Queue and the worker's
Worker are always in separate processes, so getBullMQConnection()
being a per-process singleton is fine - each process only ever has
ONE BullMQ construct using it. Here, in a single test process, a
Queue.add() and a Worker both active on the SAME connection object
contended with each other (confirmed live: running this file
alongside another real-worker-starting file reproduced a job whose
item completed but whose job aggregate never updated - the
"completed" handler's updateJobProgress() call was delayed long
enough that this test's own waitForPendingHandlers() moved on before
observing it). A dedicated connection removes that contention
entirely rather than chasing the exact interleaving.
*/
let dedicatedQueueConnection: Redis | null = null;

function getDedicatedQueueConnection(): Redis {
  if (!dedicatedQueueConnection) {
    dedicatedQueueConnection = new Redis(config.redis.url, {
      maxRetriesPerRequest: null,
    });
  }
  return dedicatedQueueConnection;
}

function getRealQueue(): Queue {
  if (!realQueue) {
    realQueue = new Queue(TEST_QUEUE_NAME, { connection: getDedicatedQueueConnection() });
  }
  return realQueue;
}

mock.module("./verificationQueue.js", {
  namedExports: {
    VERIFICATION_QUEUE_NAME: TEST_QUEUE_NAME,
    enqueueVerificationItem: async (payload: { itemId: string; jobId: string; email: string }) => {

      if (payload.itemId === targetItemId) {

        enqueueAttempts += 1;

        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          throw new Error("simulated Redis outage - connect ECONNREFUSED");
        }

      }

      await getRealQueue().add("verify-email", payload, { jobId: payload.itemId });
    },
  },
});

const verifyEmailCalls: string[] = [];

mock.module("../services/emailVerificationOrchestrator.js", {
  namedExports: {
    verifyEmail: async (email: string) => {
      verifyEmailCalls.push(email);
      return {
        email,
        verificationStatus: "VALID",
        confidence: 95,
      };
    },
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
  claimPendingOutboxRows,
  markOutboxFailed,
  commitOutboxClaim,
  recoverFailedOutboxRows,
} = await import("../services/verificationJobService.js");
const { dispatchPendingOutboxBatch } = await import("./outboxDispatcher.js");
const { startVerificationQueueWorker } = await import("./verificationQueueWorker.js");
const { getDatabase } = await import("../database/database.js");

/*
Bounded by wall-clock time, not a fixed attempt count. The shared
Postgres instance this suite runs against accumulates outbox rows
from OTHER integration test files across every run (e.g.
verificationJobService.integration.test.ts calls createVerificationJob()
directly and manipulates item status without ever dispatching -
correct for what THAT file tests, but it leaves permanently-PENDING
outbox rows sitting in the claimable pool). dispatchPendingOutboxBatch()
claims oldest-first, un-scoped (correct production behavior - a real
dispatcher must drain whatever backlog actually exists), so this
test's own row can end up several batches deep. A fixed attempt count
at a fixed delay made this flaky under a growing backlog; a generous
wall-clock deadline with a short delay does not.

60s (not 30s): under the full integration suite's heaviest concurrent
load - many other files' own dispatchers/workers all competing for
the same Postgres rows and Redis connection at once - draining enough
backlog to reach this test's own row can occasionally take a while
longer than an isolated run needs. This is headroom for real
concurrent-test throughput contention, not a cover for a hang: every
underlying mechanism this loop waits on has already been proven
correct via isolated and smaller-scale concurrent runs.
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
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

test("full outbox lifecycle: a simulated Redis outage during dispatch resolves to COMPLETED with exactly one SMTP verification, no duplicates", async () => {
  const email = `full-lifecycle-${randomUUID()}@example.com`;
  const job = await createVerificationJob([email]);
  const [item] = await listVerificationJobItems(job.jobId);
  const db = getDatabase();

  targetItemId = item.id;

  // 1. Durably accepted: job exists and is PENDING, no enqueue
  // attempt has been made yet - proves the request path itself never
  // touched Redis.
  const initialJob = await getVerificationJob(job.jobId);
  assert.equal(initialJob?.status, "PENDING");
  assert.equal(enqueueAttempts, 0);

  const { worker, waitForPendingHandlers } = startVerificationQueueWorker();

  try {

    // 2. Dispatch polls during the simulated outage - the outbox row
    // must stay PENDING (retryable), never DISPATCHED, never
    // silently dropped. The caller already has its 202; nothing here
    // can turn into a false failure at this point.
    await pollUntil(async () => {
      await dispatchPendingOutboxBatch();
      const row = await db.query(`SELECT attempts FROM verification_outbox WHERE job_id = $1`, [job.jobId]);
      return (row.rows[0]?.attempts ?? 0) >= 1;
    });

    const midOutage = await db.query(
      `SELECT status FROM verification_outbox WHERE job_id = $1`,
      [job.jobId]
    );
    assert.equal(midOutage.rows[0]?.status, "PENDING", "must stay retryable during the simulated outage");

    // 3. "Redis recovers" (failuresRemaining reaches 0) - the next
    // poll(s) succeed, enqueue into REAL BullMQ, and the real worker
    // started above picks the job up and completes it for real.
    await pollUntil(async () => {
      await dispatchPendingOutboxBatch();
      const row = await db.query(`SELECT status FROM verification_outbox WHERE job_id = $1`, [job.jobId]);
      return row.rows[0]?.status === "DISPATCHED";
    });

    await pollUntil(async () => {
      const itemRow = await db.query(`SELECT status FROM verification_job_items WHERE id = $1`, [item.id]);
      return itemRow.rows[0]?.status === "COMPLETED";
    });

    await waitForPendingHandlers();

    const finalJob = await getVerificationJob(job.jobId);
    assert.equal(finalJob?.status, "COMPLETED");
    assert.equal(finalJob?.successful, 1);

    const finalOutbox = await db.query(
      `SELECT status FROM verification_outbox WHERE job_id = $1`,
      [job.jobId]
    );
    assert.equal(finalOutbox.rows[0]?.status, "DISPATCHED");

    const allItems = await db.query(
      `SELECT id FROM verification_job_items WHERE job_id = $1`,
      [job.jobId]
    );
    assert.equal(allItems.rows.length, 1, "exactly one item for this job/email");

    // Scoped to THIS test's own email, not exact array equality: the
    // shared dispatcher batch this test's row rode in on can also
    // pick up OTHER integration test files' leftover PENDING items
    // (tests that create a job via createVerificationJob() and
    // exercise Postgres state directly, without ever running a
    // dispatcher/worker themselves - correct for what THEY test).
    // Those get dispatched into this test's isolated queue and
    // legitimately processed too, which is harmless collateral work,
    // not a duplicate of THIS item. What actually matters - and what
    // this whole test exists to prove - is that verifyEmail() ran
    // exactly once for the item this test created.
    const callsForThisEmail = verifyEmailCalls.filter((calledEmail) => calledEmail === email);
    assert.equal(
      callsForThisEmail.length,
      1,
      `verifyEmail must have run EXACTLY once for ${email} despite earlier failed enqueue attempts - no duplicate SMTP verification`
    );

  } finally {
    await worker.close();
  }
});

test("outbox exhaustion + recovery: PENDING -> max attempts -> FAILED -> explicit recovery -> DISPATCHED -> COMPLETED, exactly one SMTP verification", async () => {
  const email = `exhaustion-recovery-${randomUUID()}@example.com`;
  const job = await createVerificationJob([email]);
  const [item] = await listVerificationJobItems(job.jobId);
  const db = getDatabase();

  // Deliberately NOT this test's targetItemId - the enqueue mock's
  // failure-injection is scoped to targetItemId only (see above), so
  // this item enqueues for real on the first attempt once dispatched;
  // the FAILED state here comes from directly exhausting the retry
  // budget via markOutboxFailed(), not from a simulated Redis outage.
  const claim = await claimPendingOutboxRows(10);
  let outboxRowId: string;
  try {
    const row = claim.rows.find((r) => r.jobId === job.jobId);
    assert.ok(row, "expected this test's own row to be claimable");
    outboxRowId = row.id;
    await markOutboxFailed(claim.client, row.id, new Error("simulated permanent failure"), 20, 1_000);
  } finally {
    await commitOutboxClaim(claim.client);
  }

  const deadState = await db.query<{ status: string }>(
    `SELECT status FROM verification_outbox WHERE job_id = $1`,
    [job.jobId]
  );
  assert.equal(deadState.rows[0]?.status, "FAILED");

  // Explicit recovery - never automatic (see recoverFailedOutboxRows's
  // own doc comment in verificationJobService.ts).
  const recovery = await recoverFailedOutboxRows();
  assert.ok(recovery.recoveredIds.includes(outboxRowId), "recovery must include this specific row");

  const { worker, waitForPendingHandlers } = startVerificationQueueWorker();

  try {

    await pollUntil(async () => {
      await dispatchPendingOutboxBatch();
      const row = await db.query(`SELECT status FROM verification_outbox WHERE job_id = $1`, [job.jobId]);
      return row.rows[0]?.status === "DISPATCHED";
    });

    await pollUntil(async () => {
      const itemRow = await db.query(`SELECT status FROM verification_job_items WHERE id = $1`, [item.id]);
      return itemRow.rows[0]?.status === "COMPLETED";
    });

    await waitForPendingHandlers();

  } finally {
    await worker.close();
  }

  const finalJob = await getVerificationJob(job.jobId);
  assert.equal(finalJob?.status, "COMPLETED");
  assert.equal(finalJob?.successful, 1);

  const finalOutbox = await db.query<{ status: string; recovery_count: number }>(
    `SELECT status, recovery_count FROM verification_outbox WHERE job_id = $1`,
    [job.jobId]
  );
  assert.equal(finalOutbox.rows[0]?.status, "DISPATCHED");
  assert.equal(finalOutbox.rows[0]?.recovery_count, 1, "recovery_count must reflect that this row needed manual recovery once");

  const itemCount = await db.query(
    `SELECT id FROM verification_job_items WHERE job_id = $1`,
    [job.jobId]
  );
  assert.equal(itemCount.rows.length, 1, "exactly one item for this job/email");

  const callsForThisEmail = verifyEmailCalls.filter((calledEmail) => calledEmail === email);
  assert.equal(
    callsForThisEmail.length,
    1,
    "verifyEmail must have run EXACTLY once across the whole exhaustion/recovery/dispatch/completion cycle - no duplicate SMTP verification"
  );
});

test.after(async () => {
  const { closeDatabase } = await import("../database/database.js");
  const { closeRedis } = await import("../redis/redisClient.js");

  if (realQueue) {
    await realQueue.close();
  }

  if (dedicatedQueueConnection) {
    await dedicatedQueueConnection.quit();
  }

  await closeRedis();
  await closeDatabase();
});
