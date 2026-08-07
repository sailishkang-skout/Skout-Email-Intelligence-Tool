import {
  getDatabase
} from "../database/database.js";

import {
  runVerificationWorker
} from "./verificationWorker.js";


const DEFAULT_BATCH_SIZE = 25;


/*
==================================================
FIND JOBS WITH DUE RETRIES
==================================================

Only jobs that are still active should be
returned.

Terminal jobs must never be resurrected by
the retry scheduler.
==================================================
*/

export function getJobsWithDueRetries(
  limit = DEFAULT_BATCH_SIZE
): string[] {

  const db =
    getDatabase();


  const rows =
    db.prepare(`
      SELECT DISTINCT
        i.job_id

      FROM verification_job_items i

      INNER JOIN verification_jobs j
        ON j.id = i.job_id

      WHERE
        i.status = 'PENDING'

        AND i.next_attempt_at IS NOT NULL

        AND i.next_attempt_at <= CURRENT_TIMESTAMP

        AND i.retry_count < i.max_retries

        AND j.status IN (
          'PENDING',
          'RUNNING'
        )

      ORDER BY
        i.next_attempt_at ASC

      LIMIT ?
    `)
    .all(limit) as Array<{
      job_id: string;
    }>;


  return rows.map(
    row => row.job_id
  );

}


/*
==================================================
RUN DUE RETRIES
==================================================
*/

export async function runDueRetries(
  limit = DEFAULT_BATCH_SIZE
) {

  const jobs =
    getJobsWithDueRetries(
      limit
    );


  const results: Array<{
    jobId: string;
    success: boolean;
    result?: unknown;
    error?: string;
  }> = [];


  for (
    const jobId of jobs
  ) {

    try {

      const result =
        await runVerificationWorker(
          jobId
        );


      results.push({

        jobId,

        success: true,

        result

      });

    }

    catch (error) {

      results.push({

        jobId,

        success: false,

        error:
          error instanceof Error
            ? error.message
            : String(error)

      });

    }

  }


  return results;

}


/*
==================================================
SCHEDULER LOOP
==================================================
*/

export function startVerificationRetryScheduler(
  intervalMs = 10_000
) {

  let running = false;


  const timer =
    setInterval(
      async () => {

        /*
        Prevent overlapping scheduler
        executions inside this process.
        */

        if (running) {

          return;

        }


        running = true;


        try {

          const results =
            await runDueRetries();


          if (
            results.length > 0
          ) {

            console.log(
              "[RETRY SCHEDULER]",
              results
            );

          }

        }

        catch (error) {

          console.error(
            "[RETRY SCHEDULER ERROR]",
            error
          );

        }

        finally {

          running = false;

        }

      },
      intervalMs
    );


  return {

    stop() {

      clearInterval(
        timer
      );

    }

  };

}