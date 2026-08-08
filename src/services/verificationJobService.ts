import { randomUUID } from "node:crypto";

import {
  getDatabase
} from "../database/database.js";


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

  const insertJob = db.prepare(`
    INSERT INTO verification_jobs
    (
      id,
      status,
      total_emails
    )
    VALUES
    (
      ?,
      'PENDING',
      ?
    )
  `);

  const insertItem = db.prepare(`
    INSERT INTO verification_job_items
    (
      id,
      job_id,
      email,
      status,
      max_retries
    )
    VALUES
    (
      ?,
      ?,
      ?,
      'PENDING',
      3
    )
  `);

  const transaction =
    db.transaction(
      () => {

        insertJob.run(
          jobId,
          normalizedEmails.length
        );

        for (
          const email of normalizedEmails
        ) {

          insertItem.run(
            randomUUID(),
            jobId,
            email
          );

        }

      }
    );

  transaction();

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

export function getVerificationJob(
  jobId: string
) {

  const db = getDatabase();

  return db.prepare(`
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
    WHERE id = ?
  `).get(jobId);
}


/*
==================================================
TERMINALIZE EXHAUSTED RETRIES
==================================================

Any item that is still PENDING but has exhausted
its retry budget is terminally FAILED.

Invariant:

retry_count >= max_retries
AND status = PENDING
=> status must become FAILED

Such items must never be claimed again.
==================================================
*/

export function terminalizeExhaustedRetries(
  jobId: string
): number {

  const db = getDatabase();

  const result =
    db.prepare(`
      UPDATE verification_job_items

      SET
        status = 'FAILED',

        last_error =
          COALESCE(
            last_error,
            'Maximum verification retry attempts exhausted.'
          ),

        completed_at =
          COALESCE(
            completed_at,
            CURRENT_TIMESTAMP
          ),

        worker_id = NULL,

        processing_started_at = NULL,

        lease_expires_at = NULL,

        next_attempt_at = NULL

      WHERE
        job_id = ?

        AND status = 'PENDING'

        AND retry_count >= max_retries
    `)
    .run(jobId);

  return result.changes;
}


/*
==================================================
RECOVER STALE ITEMS
==================================================
*/

export function recoverStaleVerificationItems(
  jobId: string
): number {

  const db = getDatabase();

  const result =
    db.prepare(`
      UPDATE verification_job_items

      SET
        status = 'PENDING',

        worker_id = NULL,

        processing_started_at = NULL,

        lease_expires_at = NULL,

        retry_count =
          retry_count + 1,

        last_retry_at =
          CURRENT_TIMESTAMP,

        next_attempt_at =
          CURRENT_TIMESTAMP

      WHERE
        job_id = ?

        AND status = 'PROCESSING'

        AND lease_expires_at IS NOT NULL

        AND lease_expires_at < CURRENT_TIMESTAMP

        AND retry_count < max_retries
    `)
    .run(jobId);

  /*
  A stale item can become exhausted after this
  increment. Terminalize it immediately.
  */

  terminalizeExhaustedRetries(
    jobId
  );

  return result.changes;
}


/*
==================================================
CLAIM ITEMS
==================================================
*/

export function claimVerificationItems(
  jobId: string,
  workerId: string,
  batchSize: number,
  leaseSeconds = 300
): VerificationJobItem[] {

  const db = getDatabase();

  const claimed: VerificationJobItem[] = [];

  const transaction =
    db.transaction(
      () => {

        /*
        First recover abandoned work.
        */

        recoverStaleVerificationItems(
          jobId
        );

        /*
        Never allow exhausted retries to enter
        the worker.
        */

        terminalizeExhaustedRetries(
          jobId
        );

        const rows =
          db.prepare(`
            SELECT
              id,
              email,
              retry_count,
              max_retries,
              attempt_count

            FROM verification_job_items

            WHERE
              job_id = ?

              AND status = 'PENDING'

              AND retry_count < max_retries

              AND (
                next_attempt_at IS NULL
                OR next_attempt_at <= CURRENT_TIMESTAMP
              )

            ORDER BY
              created_at ASC

            LIMIT ?
          `)
          .all(
            jobId,
            batchSize
          ) as Array<{
            id: string;
            email: string;
            retry_count: number;
            max_retries: number;
            attempt_count: number;
          }>;

        for (
          const row of rows
        ) {

          const result =
            db.prepare(`
              UPDATE verification_job_items

              SET
                status = 'PROCESSING',

                worker_id = ?,

                processing_started_at =
                  CURRENT_TIMESTAMP,

                lease_expires_at =
                  DATETIME(
                    'now',
                    '+' || ? || ' seconds'
                  ),

                attempt_count =
                  attempt_count + 1

              WHERE
                id = ?

                AND status = 'PENDING'

                AND retry_count < max_retries
            `)
            .run(
              workerId,
              leaseSeconds,
              row.id
            );

          if (
            result.changes !== 1
          ) {
            continue;
          }

          claimed.push({
            id: row.id,
            job_id: jobId,
            email: row.email,
            status: "PROCESSING",
            retry_count: row.retry_count,
            max_retries: row.max_retries,
            attempt_count:
              row.attempt_count + 1
          });

        }

      }
    );

  transaction();

  return claimed;
}


/*
==================================================
COMPLETE ITEM
==================================================
*/

export function completeVerificationItem(
  itemId: string,
  workerId: string,
  result: unknown
): boolean {

  const db = getDatabase();

  const update =
    db.prepare(`
      UPDATE verification_job_items

      SET
        status = 'COMPLETED',

        result_json = ?,

        completed_at =
          CURRENT_TIMESTAMP,

        worker_id = NULL,

        processing_started_at = NULL,

        lease_expires_at = NULL,

        next_attempt_at = NULL

      WHERE
        id = ?

        AND status = 'PROCESSING'

        AND worker_id = ?
    `);

  const resultUpdate =
    update.run(
      JSON.stringify(result),
      itemId,
      workerId
    );

  return resultUpdate.changes === 1;
}


/*
==================================================
SCHEDULE RETRY
==================================================
*/

export function scheduleVerificationRetry(
  itemId: string,
  workerId: string,
  result: unknown,
  retryCount: number
): boolean {

  const db = getDatabase();

  const backoffSeconds =
    Math.min(
      3600,
      Math.pow(
        2,
        Math.max(0, retryCount)
      ) * 30
    );

  const update =
    db.prepare(`
      UPDATE verification_job_items

      SET
        status = 'PENDING',

        result_json = ?,

        retry_count =
          retry_count + 1,

        last_retry_at =
          CURRENT_TIMESTAMP,

        next_attempt_at =
          DATETIME(
            'now',
            '+' || ? || ' seconds'
          ),

        worker_id = NULL,

        processing_started_at = NULL,

        lease_expires_at = NULL

      WHERE
        id = ?

        AND status = 'PROCESSING'

        AND worker_id = ?

        AND retry_count < max_retries
    `);

  const updated =
    update.run(
      JSON.stringify(result),
      backoffSeconds,
      itemId,
      workerId
    );

  /*
  If this retry exhausted the budget, immediately
  terminalize it instead of leaving it pending.
  */

  if (
    updated.changes === 1
  ) {

    terminalizeExhaustedRetryItem(
      itemId
    );

  }

  return updated.changes === 1;
}


/*
==================================================
TERMINALIZE SINGLE EXHAUSTED ITEM
==================================================
*/

function terminalizeExhaustedRetryItem(
  itemId: string
): void {

  const db = getDatabase();

  db.prepare(`
    UPDATE verification_job_items

    SET
      status = 'FAILED',

      last_error =
        COALESCE(
          last_error,
          'Maximum verification retry attempts exhausted.'
        ),

      completed_at =
        COALESCE(
          completed_at,
          CURRENT_TIMESTAMP
        ),

      worker_id = NULL,

      processing_started_at = NULL,

      lease_expires_at = NULL,

      next_attempt_at = NULL

    WHERE
      id = ?

      AND status = 'PENDING'

      AND retry_count >= max_retries
  `)
  .run(itemId);
}


/*
==================================================
FAIL ITEM
==================================================
*/

export function failVerificationItem(
  itemId: string,
  workerId: string,
  error: unknown
): boolean {

  const db = getDatabase();

  const message =
    error instanceof Error
      ? error.message
      : String(error);

  const result =
    db.prepare(`
      UPDATE verification_job_items

      SET
        status = 'FAILED',

        result_json = ?,

        last_error = ?,

        completed_at =
          CURRENT_TIMESTAMP,

        worker_id = NULL,

        processing_started_at = NULL,

        lease_expires_at = NULL,

        next_attempt_at = NULL

      WHERE
        id = ?

        AND status = 'PROCESSING'

        AND worker_id = ?
    `)
    .run(
      JSON.stringify({
        error: message
      }),
      message,
      itemId,
      workerId
    );

  return result.changes === 1;
}


/*
==================================================
UPDATE PROGRESS
==================================================
*/

export function updateJobProgress(
  jobId: string
): void {

  const db = getDatabase();

  /*
  Ensure exhausted pending retries are counted
  as terminal failures.
  */

  terminalizeExhaustedRetries(
    jobId
  );

  db.prepare(`
    UPDATE verification_jobs

    SET
      processed_emails =
      (
        SELECT COUNT(*)

        FROM verification_job_items

        WHERE
          job_id = ?

          AND status IN (
            'COMPLETED',
            'FAILED'
          )
      ),

      successful =
      (
        SELECT COUNT(*)

        FROM verification_job_items

        WHERE
          job_id = ?

          AND status = 'COMPLETED'
      ),

      failed =
      (
        SELECT COUNT(*)

        FROM verification_job_items

        WHERE
          job_id = ?

          AND status = 'FAILED'
      )

    WHERE id = ?
  `)
  .run(
    jobId,
    jobId,
    jobId,
    jobId
  );
}


/*
==================================================
CHECK RETRYABLE ITEMS
==================================================
*/

export function hasPendingRetryItems(
  jobId: string
): boolean {

  const db = getDatabase();

  const row =
    db.prepare(`
      SELECT 1

      FROM verification_job_items

      WHERE
        job_id = ?

        AND status = 'PENDING'

        AND retry_count < max_retries

      LIMIT 1
    `)
    .get(jobId);

  return Boolean(row);
}


/*
==================================================
MARK RUNNING
==================================================
*/

export function markJobRunning(
  jobId: string
): void {

  const db = getDatabase();

  db.prepare(`
    UPDATE verification_jobs

    SET
      status = 'RUNNING',

      started_at =
        COALESCE(
          started_at,
          CURRENT_TIMESTAMP
        )

    WHERE
      id = ?

      AND status IN (
        'PENDING',
        'RUNNING'
      )
  `)
  .run(jobId);
}


/*
==================================================
COMPLETE JOB
==================================================
*/

export function completeJob(
  jobId: string
): void {

  const db = getDatabase();

  /*
  First convert exhausted retries into terminal
  failures and recalculate the counters.
  */

  updateJobProgress(
    jobId
  );

  const job =
    getVerificationJob(
      jobId
    ) as
      | {
          status: VerificationJobStatus;
          total_emails: number;
          processed_emails: number;
          successful: number;
          failed: number;
        }
      | undefined;

  if (!job) {
    throw new Error(
      `Verification job not found: ${jobId}`
    );
  }

  /*
  Pending retry items that still have retry budget
  mean the job is not finished.
  */

  if (
    hasPendingRetryItems(jobId)
  ) {
    return;
  }

  /*
  If all items are not terminal, do not finish.
  */

  if (
    job.processed_emails <
    job.total_emails
  ) {
    return;
  }

  const finalStatus =
    job.failed > 0
      ? "FAILED"
      : "COMPLETED";

  db.prepare(`
    UPDATE verification_jobs

    SET
      status = ?,

      completed_at =
        CURRENT_TIMESTAMP

    WHERE
      id = ?

      AND status != 'CANCELLED'
  `)
  .run(
    finalStatus,
    jobId
  );
}