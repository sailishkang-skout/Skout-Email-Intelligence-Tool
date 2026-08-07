import { randomUUID } from "node:crypto";

import {
  verifyEmail
} from "./emailVerificationOrchestrator.js";

import {
  claimVerificationItems,
  completeVerificationItem,
  failVerificationItem,
  scheduleVerificationRetry,
  updateJobProgress,
  markJobRunning,
  completeJob,
  getVerificationJob
} from "./verificationJobService.js";


const WORKER_BATCH_SIZE = 10;

const WORKER_LEASE_SECONDS = 300;


type WorkerJobStatus =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";


interface VerificationWorkerResult {

  jobId: string;

  workerId: string;

  status: WorkerJobStatus;

}


/*
==================================================
RETRYABLE RESULT DETECTION
==================================================
*/

function isRetryableVerificationResult(
  result: unknown
): boolean {

  if (
    !result ||
    typeof result !== "object"
  ) {

    return false;

  }


  const value =
    result as Record<
      string,
      unknown
    >;


  /*
  Primary retry signal.
  */

  if (
    value.retryRequired === true
  ) {

    return true;

  }


  /*
  Verification-status retry signal.
  */

  const verificationStatus =
    value.verificationStatus;


  if (
    verificationStatus &&
    typeof verificationStatus === "object"
  ) {

    const status =
      verificationStatus as Record<
        string,
        unknown
      >;


    if (
      status.retryable === true
    ) {

      return true;

    }

  }


  return false;

}


/*
==================================================
RUN VERIFICATION WORKER
==================================================
*/

export async function runVerificationWorker(
  jobId: string
): Promise<VerificationWorkerResult> {

  const workerId =
    randomUUID();


  /*
  Ensure the job is running before processing.
  */

  markJobRunning(
    jobId
  );


  while (true) {

    const items =
      claimVerificationItems(
        jobId,
        workerId,
        WORKER_BATCH_SIZE,
        WORKER_LEASE_SECONDS
      );


    /*
    No more immediately processable items.

    This can mean:

    - everything is terminal
    - a retry is waiting for next_attempt_at
    - the job has been exhausted
    */

    if (
      items.length === 0
    ) {

      break;

    }


    for (
      const item of items
    ) {

      try {

        const result =
          await verifyEmail(
            item.email
          );


        const retryable =
          isRetryableVerificationResult(
            result
          );


        /*
        Retryable result with remaining
        retry budget.
        */

        if (
          retryable &&
          item.retry_count <
            item.max_retries
        ) {

          const scheduled =
            scheduleVerificationRetry(
              item.id,
              workerId,
              result,
              item.retry_count
            );


          if (!scheduled) {

            console.warn(
              "[VERIFICATION WORKER] Unable to schedule retry:",
              item.id
            );

          }

        }

        /*
        Terminal result OR retry budget
        exhausted.

        scheduleVerificationRetry()
        terminalizes exhausted retries,
        so this branch handles terminal
        verification results.
        */

        else {

          const completed =
            completeVerificationItem(
              item.id,
              workerId,
              result
            );


          if (!completed) {

            console.warn(
              "[VERIFICATION WORKER] Verification item was no longer owned:",
              item.id
            );

          }

        }

      }

      catch (error) {

        const failed =
          failVerificationItem(
            item.id,
            workerId,
            error
          );


        if (!failed) {

          console.warn(
            "[VERIFICATION WORKER] Failed to persist verification failure:",
            item.id
          );

        }

      }


      /*
      Recalculate job counters after
      every item.
      */

      updateJobProgress(
        jobId
      );

    }

  }


  /*
  Reconcile the complete job state.

  IMPORTANT:
  completeJob() may leave the job RUNNING
  when a retry is waiting.
  */

  completeJob(
    jobId
  );


  /*
  Read the authoritative persisted state.

  The worker must never manufacture its
  own final job status.
  */

  const job =
    getVerificationJob(
      jobId
    ) as
      | {
          id: string;
          status: WorkerJobStatus;
        }
      | undefined;


  if (!job) {

    throw new Error(
      `Verification job disappeared during worker execution: ${jobId}`
    );

  }


  return {

    jobId,

    workerId,

    status:
      job.status

  };

}