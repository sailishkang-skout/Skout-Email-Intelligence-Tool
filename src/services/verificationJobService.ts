import { randomUUID } from "node:crypto";

import {
  getDatabase
} from "../database/database.js";


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

      await client.query(
        `
        INSERT INTO verification_job_items
        (id, job_id, email, status, max_retries)
        VALUES ($1, $2, $3, 'PENDING', 3)
        `,
        [randomUUID(), jobId, email]
      );

    }

    await client.query("COMMIT");

  } catch (error) {

    await client.query("ROLLBACK");
    throw error;

  } finally {

    client.release();

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
