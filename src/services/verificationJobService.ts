import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import {
  getDatabase
} from "../database/database.js";

import { extractErrorMessage } from "../utils/errorMessage.js";


/*
==================================================
VERIFICATION JOB SERVICE
==================================================

Purpose:

Durable business record for batch verification jobs
and their per-email items — created once, then
updated as the BullMQ-backed queue (see
src/queue/verificationQueue.ts) processes each item.

This service does NOT claim work, lease items, or
manage retry backoff — BullMQ owns execution,
concurrency, retries, backoff, and stalled-job
recovery. This service only owns the durable record
of what was requested and what happened, so API
consumers can poll job status and the data survives
a queue/worker restart.
==================================================
*/


export type VerificationJobStatus =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";


export interface VerificationJob {
  jobId: string;
  total: number;
  status: VerificationJobStatus;
}


export interface VerificationJobItem {
  id: string;
  job_id: string;
  email: string;
  status:
    | "PENDING"
    | "PROCESSING"
    | "COMPLETED"
    | "FAILED";
  retry_count: number;
  max_retries: number;
  attempt_count: number;
}


export interface VerificationJobRecord {
  id: string;
  status: VerificationJobStatus;
  total_emails: number;
  processed_emails: number;
  successful: number;
  failed: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}


function normalizeTimestamp(
  value: unknown
): string | null {

  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  // Anything reaching here is a primitive TEXT/VARCHAR column value
  // from pg, not an object.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return String(value);

}


/*
==================================================
CREATE JOB
==================================================
*/

export async function createVerificationJob(
  emails: string[]
): Promise<VerificationJob> {

  const db = getDatabase();

  const normalizedEmails =
    [
      ...new Set(
        emails
          .map(
            email =>
              email.trim().toLowerCase()
          )
          .filter(Boolean)
      )
    ];

  if (!normalizedEmails.length) {
    throw new Error(
      "Verification job requires at least one email."
    );
  }

  const jobId = randomUUID();

  const client = await db.connect();

  // Set only when the try block fails, so client.release() below can
  // tell pg to destroy this connection instead of returning a
  // possibly-corrupted one to the pool for the next caller to reuse.
  let releaseError: Error | undefined;

  try {

    await client.query("BEGIN");

    await client.query(
      `
      INSERT INTO verification_jobs
      (id, status, total_emails)
      VALUES ($1, 'PENDING', $2)
      `,
      [jobId, normalizedEmails.length]
    );

    for (const email of normalizedEmails) {

      const itemId = randomUUID();

      await client.query(
        `
        INSERT INTO verification_job_items
        (id, job_id, email, status, max_retries)
        VALUES ($1, $2, $3, 'PENDING', 3)
        `,
        [itemId, jobId, email]
      );

      // Written in the SAME transaction as the job/item above - see
      // 006_verification_outbox.sql. This is what makes "durably
      // accepted" true the instant this transaction commits, with no
      // dependency on Redis/BullMQ being reachable at request time.
      await client.query(
        `
        INSERT INTO verification_outbox
        (id, job_id, item_id, email, status)
        VALUES ($1, $2, $3, $4, 'PENDING')
        `,
        [randomUUID(), jobId, itemId, email]
      );

    }

    await client.query("COMMIT");

  } catch (error) {

    releaseError = error instanceof Error ? error : new Error(String(error));

    // A rollback failure (e.g. the connection died, which is often
    // WHY the original statement failed) must never mask the
    // original error - that's the one worth surfacing to the caller.
    // Log it and move on; releaseError already ensures this
    // connection gets destroyed rather than reused either way.
    await client.query("ROLLBACK").catch((rollbackError: unknown) => {
      console.error(
        "[VerificationJobService] Rollback failed after a failed job-creation transaction:",
        extractErrorMessage(rollbackError)
      );
    });

    throw error;

  } finally {

    client.release(releaseError);

  }

  return {
    jobId,
    total: normalizedEmails.length,
    status: "PENDING"
  };

}


/*
==================================================
GET JOB
==================================================
*/

export async function getVerificationJob(
  jobId: string
): Promise<VerificationJobRecord | null> {

  const db = getDatabase();

  const result = await db.query(
    `
    SELECT
      id,
      status,
      total_emails,
      processed_emails,
      successful,
      failed,
      created_at,
      started_at,
      completed_at
    FROM verification_jobs
    WHERE id = $1
    `,
    [jobId]
  );

  const row = result.rows[0];

  if (!row) {
    return null;
  }

  return {
    ...row,
    created_at: normalizeTimestamp(row.created_at) ?? row.created_at,
    started_at: normalizeTimestamp(row.started_at),
    completed_at: normalizeTimestamp(row.completed_at),
  };

}


/*
==================================================
LIST JOB ITEMS
==================================================
*/

export async function listVerificationJobItems(
  jobId: string
): Promise<Array<{
  id: string;
  email: string;
  status: string;
  attempt_count: number;
  last_error: string | null;
  result_json: unknown;
}>> {

  const db = getDatabase();

  const result = await db.query(
    `
    SELECT
      id,
      email,
      status,
      attempt_count,
      last_error,
      result_json
    FROM verification_job_items
    WHERE job_id = $1
    ORDER BY created_at ASC
    `,
    [jobId]
  );

  return result.rows;

}


/*
==================================================
MARK RUNNING
==================================================
*/

export async function markJobRunning(
  jobId: string
): Promise<void> {

  const db = getDatabase();

  await db.query(
    `
    UPDATE verification_jobs
    SET
      status = 'RUNNING',
      started_at = COALESCE(started_at, NOW())
    WHERE id = $1
      AND status IN ('PENDING', 'RUNNING')
    `,
    [jobId]
  );

}


/*
==================================================
MARK ITEM PROCESSING
==================================================
*/

export async function markItemProcessing(
  itemId: string
): Promise<void> {

  const db = getDatabase();

  await db.query(
    `
    UPDATE verification_job_items
    SET
      status = 'PROCESSING',
      processing_started_at = NOW(),
      attempt_count = attempt_count + 1
    WHERE id = $1
    `,
    [itemId]
  );

}


/*
==================================================
COMPLETE ITEM
==================================================

Called by the BullMQ processor once verifyEmail()
succeeds for this item. `attemptsMade` comes from
the BullMQ job itself, so retry counts stay accurate
even though this service no longer manages retries.
==================================================
*/

export async function completeVerificationItem(
  itemId: string,
  result: unknown,
  attemptsMade: number
): Promise<void> {

  const db = getDatabase();

  await db.query(
    `
    UPDATE verification_job_items
    SET
      status = 'COMPLETED',
      result_json = $2,
      retry_count = $3,
      completed_at = NOW()
    WHERE id = $1
    `,
    [itemId, JSON.stringify(result), Math.max(0, attemptsMade - 1)]
  );

}


/*
==================================================
FAIL ITEM
==================================================

Called once BullMQ has exhausted all attempts for
this item (the `failed` event on the Worker, not
every individual attempt failure).
==================================================
*/

export async function failVerificationItem(
  itemId: string,
  error: unknown,
  attemptsMade: number
): Promise<void> {

  const db = getDatabase();

  const message =
    error instanceof Error
      ? error.message
      : String(error);

  await db.query(
    `
    UPDATE verification_job_items
    SET
      status = 'FAILED',
      last_error = $2,
      retry_count = $3,
      completed_at = NOW()
    WHERE id = $1
    `,
    [itemId, message, Math.max(0, attemptsMade - 1)]
  );

}


/*
==================================================
UPDATE PROGRESS + FINALIZE
==================================================

Recomputes job-level counters from item state and
marks the job COMPLETED/FAILED once every item has
reached a terminal state. Safe to call repeatedly —
each call is a pure recomputation, not an increment.
==================================================
*/

export async function updateJobProgress(
  jobId: string
): Promise<void> {

  const db = getDatabase();

  await db.query(
    `
    UPDATE verification_jobs
    SET
      processed_emails = (
        SELECT COUNT(*) FROM verification_job_items
        WHERE job_id = $1 AND status IN ('COMPLETED', 'FAILED')
      ),
      successful = (
        SELECT COUNT(*) FROM verification_job_items
        WHERE job_id = $1 AND status = 'COMPLETED'
      ),
      failed = (
        SELECT COUNT(*) FROM verification_job_items
        WHERE job_id = $1 AND status = 'FAILED'
      )
    WHERE id = $1
    `,
    [jobId]
  );

  const job = await getVerificationJob(jobId);

  if (!job) {
    return;
  }

  if (job.processed_emails < job.total_emails) {
    return;
  }

  const finalStatus: VerificationJobStatus =
    job.failed > 0 && job.successful === 0
      ? "FAILED"
      : "COMPLETED";

  await db.query(
    `
    UPDATE verification_jobs
    SET status = $2, completed_at = NOW()
    WHERE id = $1 AND status != 'CANCELLED'
    `,
    [jobId, finalStatus]
  );

}


/*
==================================================
GET ITEM STATUS
==================================================

Used by the queue worker's duplicate-processing
guard: before running a real SMTP verification, it
checks whether this item has already reached a
terminal state (COMPLETED/FAILED) - which happens
when BullMQ redelivers a job (stalled-job recovery,
an outbox retry racing an already-successful prior
enqueue, etc.) after the original attempt already
finished. PROCESSING/PENDING are NOT terminal, so
legitimate in-progress retries are never blocked by
this check.
==================================================
*/

export async function getVerificationJobItemStatus(
  itemId: string
): Promise<VerificationJobItem["status"] | null> {

  const db = getDatabase();

  const result = await db.query<{
    status: VerificationJobItem["status"];
  }>(
    `
    SELECT status
    FROM verification_job_items
    WHERE id = $1
    `,
    [itemId]
  );

  return result.rows[0]?.status ?? null;

}


/*
==================================================
OUTBOX LIFECYCLE
==================================================

Purpose:

Drives the async batch pipeline's transactional
outbox (see 006_verification_outbox.sql and
src/queue/outboxDispatcher.ts). Rows are written by
createVerificationJob() above, inside the same
Postgres transaction as the job/items themselves -
this module only ever reads and updates them
afterward, on the dispatcher's side.

Claiming uses `FOR UPDATE SKIP LOCKED` and keeps the
transaction open across the caller's BullMQ enqueue
attempt (see claimPendingOutboxRows), rather than a
separate "CLAIMED" status column. This is deliberate:
row locks are released automatically on COMMIT,
ROLLBACK, *or* the claiming connection dying (a
crashed dispatcher), so a crashed dispatcher can never
leave a row stuck - the next poll (from this instance
or another) picks it straight back up. No lease/TTL
reconciliation job is needed.
==================================================
*/

export interface ClaimedOutboxRow {
  id: string;
  jobId: string;
  itemId: string;
  email: string;
  attempts: number;
}

export interface OutboxClaim {
  client: PoolClient;
  rows: ClaimedOutboxRow[];
}

/**
 * Opens a transaction and locks up to `limit` dispatchable outbox
 * rows (PENDING, due for retry) so no other dispatcher instance can
 * claim them concurrently. The caller MUST eventually call
 * commitOutboxClaim() or rollbackOutboxClaim() with the returned
 * client to release the transaction/connection - typically after
 * calling markOutboxDispatched()/markOutboxFailed() for each row
 * using that same client.
 */
export async function claimPendingOutboxRows(
  limit: number
): Promise<OutboxClaim> {

  const db = getDatabase();
  const client = await db.connect();

  try {

    await client.query("BEGIN");

    const result = await client.query<{
      id: string;
      job_id: string;
      item_id: string;
      email: string;
      attempts: number;
    }>(
      `
      SELECT id, job_id, item_id, email, attempts
      FROM verification_outbox
      WHERE status = 'PENDING' AND next_attempt_at <= NOW()
      ORDER BY created_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED
      `,
      [limit]
    );

    return {
      client,
      rows: result.rows.map(row => ({
        id: row.id,
        jobId: row.job_id,
        itemId: row.item_id,
        email: row.email,
        attempts: row.attempts,
      })),
    };

  } catch (error) {

    // BEGIN or the SELECT itself failed - this client was checked
    // out of the pool but never handed back to a caller who could
    // release it (the OutboxClaim is never returned), so it must be
    // released here or it leaks from the pool permanently.
    client.release(error instanceof Error ? error : new Error(String(error)));
    throw error;

  }

}

/**
 * Records a successful BullMQ enqueue. Must be called using the same
 * client returned by claimPendingOutboxRows(), before that claim is
 * committed.
 */
export async function markOutboxDispatched(
  client: PoolClient,
  outboxId: string
): Promise<void> {

  await client.query(
    `
    UPDATE verification_outbox
    SET status = 'DISPATCHED', dispatched_at = NOW(), last_error = NULL
    WHERE id = $1
    `,
    [outboxId]
  );

}

/*
Redis outages are expected to be transient and self-resolving, so a
failed enqueue attempt keeps the row PENDING/retryable rather than
dead-lettering it immediately - only after MAX_OUTBOX_ATTEMPTS
(generous: at capped backoff this is hours of retrying) does it flip
to the terminal FAILED status, as a safety valve against a row that's
permanently broken for a reason retries can't fix (e.g. malformed
data), rather than against ordinary infrastructure flakiness.
*/
const MAX_OUTBOX_ATTEMPTS = 20;

/**
 * Records a failed BullMQ enqueue attempt with backoff. Must be
 * called using the same client returned by claimPendingOutboxRows(),
 * before that claim is committed. Safe to call again for the same
 * row after a crash mid-dispatch - re-attempting an enqueue whose
 * jobId was already used is a BullMQ no-op, not a duplicate.
 */
export async function markOutboxFailed(
  client: PoolClient,
  outboxId: string,
  error: unknown,
  attemptsMade: number,
  backoffMs: number
): Promise<void> {

  const terminal = attemptsMade >= MAX_OUTBOX_ATTEMPTS;

  await client.query(
    `
    UPDATE verification_outbox
    SET
      attempts = $2,
      next_attempt_at = NOW() + ($3 || ' milliseconds')::interval,
      last_error = $4,
      status = CASE WHEN $5 THEN 'FAILED' ELSE status END
    WHERE id = $1
    `,
    [outboxId, attemptsMade, backoffMs, extractErrorMessage(error), terminal]
  );

}

/**
 * Releases the claim's connection unconditionally (try/finally), even
 * if COMMIT itself fails - a dead/corrupted connection is destroyed
 * (release(error)) rather than returned to the pool for reuse. The
 * caller (see outboxDispatcher.ts) must treat a thrown error here as
 * "this client is already gone" and never attempt to also call
 * rollbackOutboxClaim() on the same client afterward.
 */
export async function commitOutboxClaim(
  client: PoolClient
): Promise<void> {

  let releaseError: Error | undefined;

  try {

    await client.query("COMMIT");

  } catch (error) {

    releaseError = error instanceof Error ? error : new Error(String(error));
    throw error;

  } finally {

    client.release(releaseError);

  }

}

/**
 * Same release guarantee as commitOutboxClaim() - see its doc comment.
 */
export async function rollbackOutboxClaim(
  client: PoolClient
): Promise<void> {

  let releaseError: Error | undefined;

  try {

    await client.query("ROLLBACK");

  } catch (error) {

    releaseError = error instanceof Error ? error : new Error(String(error));
    throw error;

  } finally {

    client.release(releaseError);

  }

}


/*
==================================================
DEAD-LETTER RECOVERY + OBSERVABILITY
==================================================

Purpose:

A row that exhausts MAX_OUTBOX_ATTEMPTS (see
markOutboxFailed above) flips to the terminal FAILED
status and the dispatcher's claim query
(`WHERE status = 'PENDING'`) will never select it
again on its own - by design, so a permanently-broken
row doesn't spin the dispatcher forever retrying
something retries can't fix. But that means recovery
must be an explicit, deliberate action (see
src/db/recoverOutbox.ts), never something the
dispatcher does automatically on every poll - looping
recovery into the dispatcher itself would defeat the
entire point of dead-lettering.

getOutboxSummary() is the visibility half: without it,
a stuck backlog (or a dead-lettered row) is invisible
until someone thinks to query Postgres directly. It's
intentionally a single aggregate query, cheap enough
to call from a health/observability endpoint without
slowing it down (see routes/health.ts).
==================================================
*/

export interface OutboxRecoveryResult {
  recoveredCount: number;
  recoveredIds: string[];
}

/**
 * Resets up to `limit` FAILED outbox rows back to PENDING with a
 * fresh attempt budget (attempts reset to 0, last_error cleared,
 * next_attempt_at set to now), so the next normal dispatcher poll
 * picks them up through the SAME path as any other pending row -
 * no separate re-enqueue logic, so it inherits every existing
 * duplicate-protection guarantee (BullMQ jobId dedup,
 * enqueueVerificationItem's idempotent add, the worker's
 * terminal-status guard) rather than bypassing any of them.
 *
 * recovery_count is incremented (never reset) so the fact that a row
 * needed manual recovery - and how many times - stays visible even
 * though the raw attempt count itself is intentionally reset. Safe
 * to call repeatedly: a row already back to PENDING (or DISPATCHED)
 * simply won't match `status = 'FAILED'` on a subsequent call, so
 * there is no risk of double-recovering or looping a row forever.
 */
export async function recoverFailedOutboxRows(
  limit = 100
): Promise<OutboxRecoveryResult> {

  const db = getDatabase();

  const result = await db.query<{ id: string }>(
    `
    UPDATE verification_outbox
    SET
      status = 'PENDING',
      attempts = 0,
      next_attempt_at = NOW(),
      last_error = NULL,
      recovery_count = recovery_count + 1,
      last_recovered_at = NOW()
    WHERE id IN (
      SELECT id
      FROM verification_outbox
      WHERE status = 'FAILED'
      ORDER BY created_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
    `,
    [limit]
  );

  return {
    recoveredCount: result.rowCount ?? 0,
    recoveredIds: result.rows.map(row => row.id),
  };

}

export interface OutboxStatusSummary {
  count: number;
  oldestAgeMs: number | null;
}

export interface OutboxSummary {
  pending: OutboxStatusSummary;
  dispatched: OutboxStatusSummary;
  failed: OutboxStatusSummary;
}

/**
 * Cheap aggregate snapshot of the outbox's current health - how much
 * work is waiting, how much has permanently failed, and how stale the
 * oldest row in each bucket is. Intended for a health/observability
 * endpoint (see routes/health.ts) and for the recovery CLI to report
 * what it's about to act on.
 */
export async function getOutboxSummary(): Promise<OutboxSummary> {

  const db = getDatabase();

  const result = await db.query<{
    status: "PENDING" | "DISPATCHED" | "FAILED";
    count: string;
    oldest_created_at: Date | null;
  }>(
    `
    SELECT status, COUNT(*) AS count, MIN(created_at) AS oldest_created_at
    FROM verification_outbox
    WHERE status IN ('PENDING', 'DISPATCHED', 'FAILED')
    GROUP BY status
    `
  );

  const now = Date.now();

  const byStatus: OutboxSummary = {
    pending: { count: 0, oldestAgeMs: null },
    dispatched: { count: 0, oldestAgeMs: null },
    failed: { count: 0, oldestAgeMs: null },
  };

  const keyForStatus: Record<string, keyof OutboxSummary> = {
    PENDING: "pending",
    DISPATCHED: "dispatched",
    FAILED: "failed",
  };

  for (const row of result.rows) {

    const key = keyForStatus[row.status];

    if (!key) {
      continue;
    }

    byStatus[key] = {
      count: Number(row.count),
      oldestAgeMs: row.oldest_created_at ? now - row.oldest_created_at.getTime() : null,
    };

  }

  return byStatus;

}


/*
==================================================
STALE PROCESSING ITEM RECOVERY
==================================================

Purpose:

BullMQ's Worker "completed"/"failed" events are not
awaited by BullMQ itself - they're plain EventEmitter
listeners that persist the outcome to Postgres
afterward (see verificationQueueWorker.ts). BullMQ's
own Redis-side bookkeeping (moving the job to its
completed/failed set) happens BEFORE those listeners
run, and is final: a job BullMQ considers completed or
failed is never redelivered, no matter what happens to
our own listener afterward.

If the worker process is killed (SIGKILL/OOM) in the
narrow window between BullMQ recording that outcome and
our listener's Postgres write finishing,
verification_job_items.status is left at PROCESSING
forever - BullMQ has already decided the job's fate and
will not hand it to another worker, and Postgres has no
record that anything happened. Confirmed real (not
theoretical) by tracing exactly when the 'completed'
event fires and what waitForPendingHandlers() does and
does not cover (graceful shutdown only, not a hard
crash) - see worker.ts.

Recovery must NOT re-enqueue the same itemId to force a
redo: BullMQ's custom-jobId add() is a no-op whenever a
job with that id already exists in ANY state, including
completed/failed (see addStandardJob-9.lua's EXISTS
check + handleDuplicatedJob.lua) - it will never revive
or reprocess it. The only reliable recovery is to ask
each of the two systems what it actually knows and
reconcile Postgres to match:

  - verification_results already has a row for this
    item (verificationId === itemId - see
    emailVerificationOrchestrator.ts/
    verificationQueueWorker.ts) -> the work genuinely
    finished and committed atomically (see the result/
    decision transaction fix) before the crash; mark
    the item COMPLETED directly from that durable data.
    No re-verification, no BullMQ interaction needed.

  - otherwise, ask BullMQ directly (Job.isCompleted()/
    isFailed()) what happened to the underlying job:
      - failed (attempts exhausted) -> mark the item
        FAILED; the retry budget is genuinely spent,
        re-running would just fail again.
      - completed with no verification_results row ->
        should be impossible given the atomic result/
        decision transaction; treated as a data-
        integrity alarm, not silently papered over.
      - still active/waiting/delayed, or no BullMQ
        record at all -> not actually stuck (still
        genuinely in flight, legitimately queued for a
        BullMQ-owned retry, or too ambiguous to act on
        automatically) - left untouched rather than
        guessed at.

This never triggers a second real SMTP verification:
every branch above either recovers from data that
already exists or defers to BullMQ's own outcome,
never re-runs verifyEmail().

Deliberately does NOT use/reactivate the dead
worker_id/lease_expires_at columns (see
003_verification_jobs.sql) - they were never populated
by the current BullMQ-based worker (grep confirms zero
reads/writes anywhere in application code) and nothing
about this recovery needs per-worker attribution: a
single time-based staleness check on the already-
populated processing_started_at, combined with
FOR UPDATE SKIP LOCKED claiming (the same pattern
claimPendingOutboxRows already uses) for safety across
multiple worker replicas, is sufficient. No migration
needed.
==================================================
*/

export interface ClaimedStaleProcessingItem {
  id: string;
  jobId: string;
  email: string;
  attemptCount: number;
}

export interface StaleProcessingClaim {
  client: PoolClient;
  rows: ClaimedStaleProcessingItem[];
}

/**
 * Claims up to `limit` verification_job_items that have been
 * PROCESSING for longer than `staleThresholdMs`, via the same
 * FOR UPDATE SKIP LOCKED pattern claimPendingOutboxRows() uses, so
 * multiple worker replicas' reconcilers never claim the same row.
 * Caller MUST follow up with commitProcessingItemsClaim() or
 * rollbackProcessingItemsClaim() using the returned client.
 */
export async function claimStaleProcessingItems(
  limit: number,
  staleThresholdMs: number
): Promise<StaleProcessingClaim> {

  const db = getDatabase();
  const client = await db.connect();

  try {

    await client.query("BEGIN");

    const result = await client.query<{
      id: string;
      job_id: string;
      email: string;
      attempt_count: number;
    }>(
      `
      SELECT id, job_id, email, attempt_count
      FROM verification_job_items
      WHERE status = 'PROCESSING'
        AND processing_started_at <= NOW() - ($2 || ' milliseconds')::interval
      ORDER BY processing_started_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED
      `,
      [limit, staleThresholdMs]
    );

    return {
      client,
      rows: result.rows.map(row => ({
        id: row.id,
        jobId: row.job_id,
        email: row.email,
        attemptCount: row.attempt_count,
      })),
    };

  } catch (error) {

    // Same reasoning as claimPendingOutboxRows(): this client was
    // checked out but never handed to a caller who could release it,
    // so it must be released here or it leaks from the pool.
    client.release(error instanceof Error ? error : new Error(String(error)));
    throw error;

  }

}

/**
 * Same contract as commitOutboxClaim() - see its doc comment.
 */
export async function commitProcessingItemsClaim(
  client: PoolClient
): Promise<void> {

  let releaseError: Error | undefined;

  try {

    await client.query("COMMIT");

  } catch (error) {

    releaseError = error instanceof Error ? error : new Error(String(error));
    throw error;

  } finally {

    client.release(releaseError);

  }

}

/**
 * Same contract as rollbackOutboxClaim() - see its doc comment.
 */
export async function rollbackProcessingItemsClaim(
  client: PoolClient
): Promise<void> {

  let releaseError: Error | undefined;

  try {

    await client.query("ROLLBACK");

  } catch (error) {

    releaseError = error instanceof Error ? error : new Error(String(error));
    throw error;

  } finally {

    client.release(releaseError);

  }

}

/**
 * Marks a claimed stale item COMPLETED using a verification_results/
 * verification_decisions row that already exists for it - the work
 * genuinely finished before the crash, so this is a pure Postgres
 * reconciliation, never a re-verification. The `AND status =
 * 'PROCESSING'` guard is redundant with FOR UPDATE SKIP LOCKED (belt
 * and suspenders, costs nothing).
 */
export async function markStaleItemCompletedFromPersistedResult(
  client: PoolClient,
  itemId: string,
  resultJson: Record<string, unknown>
): Promise<void> {

  await client.query(
    `
    UPDATE verification_job_items
    SET
      status = 'COMPLETED',
      result_json = $2,
      completed_at = NOW()
    WHERE id = $1 AND status = 'PROCESSING'
    `,
    [itemId, JSON.stringify(resultJson)]
  );

}

/**
 * Marks a claimed stale item FAILED because BullMQ itself already
 * confirms the underlying job exhausted its retry budget - the
 * retry budget is genuinely spent, so this reconciles Postgres to
 * match BullMQ's own final answer rather than attempting another
 * real SMTP verification.
 */
export async function markStaleItemFailedFromBullMQState(
  client: PoolClient,
  itemId: string,
  reason: string
): Promise<void> {

  await client.query(
    `
    UPDATE verification_job_items
    SET
      status = 'FAILED',
      last_error = $2,
      completed_at = NOW()
    WHERE id = $1 AND status = 'PROCESSING'
    `,
    [itemId, reason]
  );

}

/**
 * Pushes a claimed-but-unresolved item's processing_started_at
 * forward instead of leaving it untouched. Neither COMPLETED nor
 * FAILED is warranted (see jobItemReconciler.ts's "unresolved"
 * branch), but leaving processing_started_at unchanged would let it
 * sit forever at the front of claimStaleProcessingItems()'s oldest-
 * first ordering - re-claimed and re-logged on every single poll,
 * while permanently starving any genuinely-recoverable newer stale
 * item behind it once an unresolved backlog reaches BATCH_SIZE
 * (found empirically: this test suite's own deliberately-stuck test
 * fixtures reproduced exactly this starvation). Moving it only
 * halfway back toward the staleness threshold (not to "just now")
 * keeps it discoverable again soon, rather than effectively hiding
 * it - it still reaches the front on its own once nothing has
 * resolved it for the remaining half of the threshold.
 */
export async function touchUnresolvedStaleItem(
  client: PoolClient,
  itemId: string,
  staleThresholdMs: number
): Promise<void> {

  await client.query(
    `
    UPDATE verification_job_items
    SET processing_started_at = NOW() - ($2 || ' milliseconds')::interval
    WHERE id = $1 AND status = 'PROCESSING'
    `,
    [itemId, Math.floor(staleThresholdMs / 2)]
  );

}
