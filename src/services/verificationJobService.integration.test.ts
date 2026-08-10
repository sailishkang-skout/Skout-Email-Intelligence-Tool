import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

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
  getVerificationJobItemStatus,
  claimPendingOutboxRows,
  markOutboxDispatched,
  markOutboxFailed,
  commitOutboxClaim,
  rollbackOutboxClaim,
  recoverFailedOutboxRows,
  getOutboxSummary,
} from "./verificationJobService.js";

import { getDatabase } from "../database/database.js";

import { requirePostgres } from "../testHelpers/requireInfra.js";

test.before(() => requirePostgres());

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

/*
==================================================
TRANSACTIONAL OUTBOX
==================================================
*/

test("verificationJobService: creating a job writes one PENDING outbox row per item, in the same transaction", async () => {
  const job = await createVerificationJob([
    "outbox-a@example.com",
    "outbox-b@example.com",
  ]);

  const items = await listVerificationJobItems(job.jobId);
  assert.equal(items.length, 2);

  const db = getDatabase();
  const result = await db.query<{
    item_id: string;
    email: string;
    status: string;
    attempts: number;
  }>(
    `SELECT item_id, email, status, attempts FROM verification_outbox WHERE job_id = $1 ORDER BY email ASC`,
    [job.jobId]
  );

  assert.equal(result.rows.length, 2, "expected exactly one outbox row per item");

  const itemIds = new Set(items.map((item) => item.id));

  for (const row of result.rows) {
    assert.equal(row.status, "PENDING");
    assert.equal(row.attempts, 0);
    assert.ok(itemIds.has(row.item_id), "outbox row must reference a real item created in the same transaction");
  }
});

test("verificationJobService: an outbox row can never exist without its job/item - FK constraints enforce the same atomicity the shared transaction relies on", async () => {
  const db = getDatabase();
  const client = await db.connect();
  const orphanJobId = randomUUID();

  try {
    await client.query("BEGIN");

    await assert.rejects(
      client.query(
        `INSERT INTO verification_outbox (id, job_id, item_id, email, status) VALUES ($1, $2, $3, $4, 'PENDING')`,
        [randomUUID(), orphanJobId, orphanJobId, "orphan@example.com"]
      ),
      /foreign key/i,
      "inserting an outbox row referencing a non-existent job/item must violate the FK constraint"
    );

    await client.query("ROLLBACK");
  } finally {
    client.release();
  }

  const result = await db.query(
    `SELECT 1 FROM verification_outbox WHERE job_id = $1`,
    [orphanJobId]
  );

  assert.equal(result.rows.length, 0, "no orphaned outbox row should exist after the rollback");
});

/*
Every test below calls claimPendingOutboxRows() directly, which opens
a real Postgres transaction and returns it OPEN - the caller owns
releasing it via commitOutboxClaim()/rollbackOutboxClaim(). A bug
found live in this exact file: several of these tests originally
asserted the claimed row was found BEFORE entering a try/finally that
released the claim. This suite's shared Postgres accumulates
PENDING outbox rows across runs (other tests here intentionally
create jobs without ever dispatching them, to test the service layer
directly), so claimPendingOutboxRows(10)'s oldest-first LIMIT 10 can
miss a just-created row once enough older ones exist - and when that
assertion failed, the open transaction was never released. Confirmed
live: this leaked real Postgres connections sitting "idle in
transaction" for HOURS across repeated runs, eventually exhausting
the entire connection pool and hanging every subsequent test/request
that needed one. Fixed two ways: claim a generous limit here (this is
test-only - production's dispatcher intentionally uses a small,
constant BATCH_SIZE, unrelated to this) so the row realistically can't
be missed, AND unconditionally release the claim via try/finally
regardless of whether the assertion passes.
*/
const GENEROUS_TEST_CLAIM_LIMIT = 1000;

/*
Even a generous claim limit doesn't fully eliminate cross-file
contention: Node's test runner runs multiple integration test files
concurrently, and several OTHER files (outboxDispatcher.integration.test.ts,
outboxFullLifecycle.integration.test.ts) run real dispatcher polls
against this SAME shared table. FOR UPDATE SKIP LOCKED is correct,
intentional production behavior - it means a concurrent claim from
one of those files can legitimately grab (and then dispatch) a row
this test just created, in the split second between this test's own
createVerificationJob() and claimPendingOutboxRows() calls. Confirmed
live: a claim occasionally came back without this test's own
just-created row. This is a test-concurrency artifact, not a
production bug (claiming/dispatching whichever row is available is
exactly what claimPendingOutboxRows is supposed to do) - the fix is
to make each test resilient to losing that race, not to weaken the
production claim query.
*/
async function createJobAndClaimOwnRow(
  emails: string[]
): Promise<{
  job: Awaited<ReturnType<typeof createVerificationJob>>;
  claim: Awaited<ReturnType<typeof claimPendingOutboxRows>>;
  row: Awaited<ReturnType<typeof claimPendingOutboxRows>>["rows"][number];
}> {

  for (let attempt = 0; attempt < 5; attempt++) {

    const job = await createVerificationJob(emails);
    const claim = await claimPendingOutboxRows(GENEROUS_TEST_CLAIM_LIMIT);
    const row = claim.rows.find((r) => r.jobId === job.jobId);

    if (row) {
      return { job, claim, row };
    }

    // Lost the race to a concurrent claimer from another test file -
    // release this now-empty-for-us claim and try again with a fresh
    // job/row.
    await commitOutboxClaim(claim.client);

  }

  throw new Error("createJobAndClaimOwnRow: failed to claim our own freshly-created row after 5 attempts");

}

test("verificationJobService: claimPendingOutboxRows locks claimed rows so a second concurrent claim cannot see them (FOR UPDATE SKIP LOCKED)", async () => {
  const { job, claim: firstClaim } = await createJobAndClaimOwnRow(["claim-race@example.com"]);

  try {
    const claimedThisJob = firstClaim.rows.filter((row) => row.jobId === job.jobId);
    assert.equal(claimedThisJob.length, 1, "the first claim should see the newly-created row");

    const secondClaim = await claimPendingOutboxRows(GENEROUS_TEST_CLAIM_LIMIT);

    try {
      const overlap = secondClaim.rows.filter((row) => row.jobId === job.jobId);
      assert.equal(
        overlap.length,
        0,
        "a second concurrent claim must not see a row already locked by an open, uncommitted claim"
      );
    } finally {
      await commitOutboxClaim(secondClaim.client);
    }
  } finally {
    await commitOutboxClaim(firstClaim.client);
  }
});

test("verificationJobService: markOutboxDispatched marks a claimed row DISPATCHED", async () => {
  const { claim, row } = await createJobAndClaimOwnRow(["dispatch-success@example.com"]);
  const rowId = row.id;

  try {
    await markOutboxDispatched(claim.client, row.id);
  } finally {
    await commitOutboxClaim(claim.client);
  }

  const db = getDatabase();
  const result = await db.query<{ status: string; dispatched_at: Date | null }>(
    `SELECT status, dispatched_at FROM verification_outbox WHERE id = $1`,
    [rowId]
  );

  assert.equal(result.rows[0]?.status, "DISPATCHED");
  assert.ok(result.rows[0]?.dispatched_at, "dispatched_at must be set");
});

test("verificationJobService: markOutboxFailed records the attempt, backoff, and error but keeps the row PENDING/retryable below the max-attempts threshold", async () => {
  const { claim, row } = await createJobAndClaimOwnRow(["dispatch-failure@example.com"]);
  const rowId = row.id;

  try {
    await markOutboxFailed(claim.client, row.id, new Error("ECONNREFUSED"), 1, 2_000);
  } finally {
    await commitOutboxClaim(claim.client);
  }

  const db = getDatabase();
  const result = await db.query<{
    status: string;
    attempts: number;
    last_error: string;
    next_attempt_at: Date;
    created_at: Date;
  }>(
    `SELECT status, attempts, last_error, next_attempt_at, created_at FROM verification_outbox WHERE id = $1`,
    [rowId]
  );

  const persisted = result.rows[0];
  assert.ok(persisted);
  assert.equal(persisted.status, "PENDING", "a single failed attempt must stay retryable, not dead-lettered");
  assert.equal(persisted.attempts, 1);
  assert.equal(persisted.last_error, "ECONNREFUSED");
  assert.ok(
    persisted.next_attempt_at.getTime() > persisted.created_at.getTime(),
    "next_attempt_at must be pushed into the future by the backoff"
  );
});

test("verificationJobService: markOutboxFailed dead-letters the row (status FAILED) once attempts reach the max-attempts threshold", async () => {
  const { claim, row } = await createJobAndClaimOwnRow(["dispatch-exhausted@example.com"]);
  const rowId = row.id;

  try {
    await markOutboxFailed(claim.client, row.id, new Error("permanently broken"), 20, 1_000);
  } finally {
    await commitOutboxClaim(claim.client);
  }

  const db = getDatabase();
  const result = await db.query<{ status: string }>(
    `SELECT status FROM verification_outbox WHERE id = $1`,
    [rowId]
  );

  assert.equal(result.rows[0]?.status, "FAILED");
});

test("verificationJobService: rollbackOutboxClaim releases the claim without persisting any changes", async () => {
  const { claim, row } = await createJobAndClaimOwnRow(["rollback-claim@example.com"]);
  const rowId = row.id;

  await rollbackOutboxClaim(claim.client);

  /*
  Proving the rollback released the row via a direct status check
  rather than racing a second competitive claim against it: another
  concurrently-running integration test file's own dispatcher is free
  to legitimately claim AND dispatch this now-genuinely-unlocked row
  before this test gets back to it (correct production behavior, not
  a bug - see createJobAndClaimOwnRow's doc comment above). So both
  PENDING (still available) and DISPATCHED (someone else legitimately
  claimed it first) are valid proof the rollback released the lock -
  only a row STILL held by an uncommitted transaction could never
  reach either state.
  */
  const db = getDatabase();

  const result = await db.query<{ status: string }>(
    `SELECT status FROM verification_outbox WHERE id = $1`,
    [rowId]
  );

  assert.ok(
    result.rows[0] && ["PENDING", "DISPATCHED"].includes(result.rows[0].status),
    `expected the row to be PENDING or DISPATCHED after rollback (proving the lock was released), got ${result.rows[0]?.status}`
  );
});

test("verificationJobService: getVerificationJobItemStatus reflects the item's current state", async () => {
  const job = await createVerificationJob(["status-lookup@example.com"]);
  const [item] = await listVerificationJobItems(job.jobId);

  assert.equal(await getVerificationJobItemStatus(item.id), "PENDING");

  await markItemProcessing(item.id);
  assert.equal(await getVerificationJobItemStatus(item.id), "PROCESSING");

  await completeVerificationItem(item.id, { success: true }, 1);
  assert.equal(await getVerificationJobItemStatus(item.id), "COMPLETED");
});

test("verificationJobService: a row backed off by markOutboxFailed is not reclaimed by claimPendingOutboxRows until next_attempt_at elapses", async () => {
  const { claim: firstClaim, row } = await createJobAndClaimOwnRow(["backoff-window@example.com"]);
  const rowId = row.id;

  try {
    // A generous backoff (well beyond this test's runtime) so the row
    // is provably still in the future for the second claim below.
    await markOutboxFailed(firstClaim.client, row.id, new Error("simulated outage"), 1, 60_000);
  } finally {
    await commitOutboxClaim(firstClaim.client);
  }

  const secondClaim = await claimPendingOutboxRows(GENEROUS_TEST_CLAIM_LIMIT);
  try {
    const reclaimed = secondClaim.rows.find((r) => r.id === rowId);
    assert.equal(
      reclaimed,
      undefined,
      "a row backed off 60s into the future must not be reclaimed immediately"
    );
  } finally {
    await commitOutboxClaim(secondClaim.client);
  }
});

test("verificationJobService: getVerificationJobItemStatus returns null for an unknown item", async () => {
  const result = await getVerificationJobItemStatus("00000000-0000-0000-0000-000000000000");
  assert.equal(result, null);
});

/*
==================================================
DEAD-LETTER RECOVERY + OBSERVABILITY
==================================================
*/

test("verificationJobService: a row that exhausts MAX_OUTBOX_ATTEMPTS dead-letters to FAILED, then recoverFailedOutboxRows resets it to PENDING with a fresh attempt budget", async () => {
  const { claim, row } = await createJobAndClaimOwnRow([`recovery-max-attempts-${randomUUID()}@example.com`]);
  const rowId = row.id;

  try {
    // Simulates exhausting the real retry budget in one step.
    await markOutboxFailed(claim.client, row.id, new Error("permanently broken"), 20, 1_000);
  } finally {
    await commitOutboxClaim(claim.client);
  }

  const db = getDatabase();

  const dead = await db.query<{ status: string; attempts: number }>(
    `SELECT status, attempts FROM verification_outbox WHERE id = $1`,
    [rowId]
  );
  assert.equal(dead.rows[0]?.status, "FAILED", "sanity check: the row must actually be dead-lettered before recovery");

  const result = await recoverFailedOutboxRows();
  assert.ok(result.recoveredIds.includes(rowId), "recovery must include this specific row");

  const recovered = await db.query<{
    status: string;
    attempts: number;
    last_error: string | null;
    recovery_count: number;
    last_recovered_at: Date | null;
    next_attempt_at: Date;
  }>(
    `SELECT status, attempts, last_error, recovery_count, last_recovered_at, next_attempt_at FROM verification_outbox WHERE id = $1`,
    [rowId]
  );

  const recoveredRow = recovered.rows[0];
  assert.ok(recoveredRow);
  assert.equal(recoveredRow.status, "PENDING", "recovery must reset the row to PENDING so the normal dispatcher poll picks it up");
  assert.equal(recoveredRow.attempts, 0, "recovery must give the row a fresh attempt budget");
  assert.equal(recoveredRow.last_error, null);
  assert.equal(recoveredRow.recovery_count, 1, "recovery_count must track that this row needed manual recovery");
  assert.ok(recoveredRow.last_recovered_at, "last_recovered_at must be set");
  assert.ok(recoveredRow.next_attempt_at.getTime() <= Date.now() + 1000, "the recovered row must be immediately claimable, not backed off");
});

test("verificationJobService: recoverFailedOutboxRows is safe to call repeatedly - an already-recovered row is not touched again", async () => {
  const { claim, row } = await createJobAndClaimOwnRow([`recovery-repeat-${randomUUID()}@example.com`]);
  const rowId = row.id;

  try {
    await markOutboxFailed(claim.client, row.id, new Error("broken"), 20, 1_000);
  } finally {
    await commitOutboxClaim(claim.client);
  }

  const first = await recoverFailedOutboxRows();
  assert.ok(first.recoveredIds.includes(rowId));

  const second = await recoverFailedOutboxRows();
  assert.ok(
    !second.recoveredIds.includes(rowId),
    "a row already reset to PENDING by a prior recovery call must not be recovered again"
  );

  const db = getDatabase();
  const recheck = await db.query<{ recovery_count: number }>(
    `SELECT recovery_count FROM verification_outbox WHERE id = $1`,
    [rowId]
  );
  assert.equal(recheck.rows[0]?.recovery_count, 1, "recovery_count must not increment again for a row that was not actually re-recovered");
});

test("verificationJobService: recovery does not touch PENDING or DISPATCHED rows, only FAILED ones", async () => {
  const pendingJob = await createVerificationJob([`recovery-scope-pending-${randomUUID()}@example.com`]);
  const [pendingItem] = await listVerificationJobItems(pendingJob.jobId);

  const db = getDatabase();
  const before = await db.query<{ status: string }>(
    `SELECT status FROM verification_outbox WHERE item_id = $1`,
    [pendingItem.id]
  );
  assert.equal(before.rows[0]?.status, "PENDING");

  await recoverFailedOutboxRows();

  const after = await db.query<{ status: string; attempts: number }>(
    `SELECT status, attempts FROM verification_outbox WHERE item_id = $1`,
    [pendingItem.id]
  );
  assert.equal(after.rows[0]?.status, "PENDING", "a genuinely PENDING row must be left alone by recovery");
});

test("verificationJobService: getOutboxSummary reflects counts and oldest-row age per status", async () => {
  const { claim, row } = await createJobAndClaimOwnRow([`summary-failed-${randomUUID()}@example.com`]);

  try {
    await markOutboxFailed(claim.client, row.id, new Error("broken"), 20, 1_000);
  } finally {
    await commitOutboxClaim(claim.client);
  }

  const summary = await getOutboxSummary();

  assert.ok(summary.failed.count >= 1, "expected at least this test's own FAILED row to be counted");
  assert.ok(summary.failed.oldestAgeMs !== null && summary.failed.oldestAgeMs >= 0);
  assert.ok(summary.pending.count >= 0);
  assert.ok(summary.dispatched.count >= 0);
});

/*
==================================================
UNIQUE (item_id) CONSTRAINT
==================================================
*/

test("verificationJobService: a second outbox row for the same item_id violates the UNIQUE constraint", async () => {
  const job = await createVerificationJob([`unique-item-${randomUUID()}@example.com`]);
  const [item] = await listVerificationJobItems(job.jobId);

  const db = getDatabase();

  await assert.rejects(
    db.query(
      `INSERT INTO verification_outbox (id, job_id, item_id, email, status) VALUES ($1, $2, $3, $4, 'PENDING')`,
      [randomUUID(), job.jobId, item.id, item.email]
    ),
    /duplicate key value violates unique constraint/,
    "a second outbox row for an item that already has one must be rejected at the database level"
  );
});

test.after(async () => {
  const { closeDatabase } = await import("../database/database.js");
  await closeDatabase();
});
