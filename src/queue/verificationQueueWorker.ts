import { Worker, type Job } from "bullmq";

import { getBullMQConnection } from "../redis/redisClient.js";
import { config } from "../config/config.js";

import {
  VERIFICATION_QUEUE_NAME,
  type VerificationJobPayload,
} from "./verificationQueue.js";

import { verifyEmail } from "../services/emailVerificationOrchestrator.js";

import {
  markItemProcessing,
  completeVerificationItem,
  failVerificationItem,
  updateJobProgress,
} from "../services/verificationJobService.js";

/*
==================================================
VERIFICATION QUEUE WORKER
==================================================

Purpose:

Consumes the durable verification queue. This is
the canonical execution mechanism for asynchronous
batch verification — BullMQ owns concurrency,
retries, exponential backoff, and stalled-job
recovery (if a worker process dies mid-job, BullMQ's
lock renewal/expiry moves the job back to `waiting`
for another worker to pick up).

Runs as its own process (see src/worker.ts) so API
instances and worker instances scale independently.
==================================================
*/

async function processVerificationJob(
  job: Job<VerificationJobPayload>
): Promise<unknown> {

  await markItemProcessing(job.data.itemId);

  return verifyEmail(job.data.email);

}

export function startVerificationQueueWorker(): Worker<VerificationJobPayload> {

  const worker = new Worker<VerificationJobPayload>(
    VERIFICATION_QUEUE_NAME,
    processVerificationJob,
    {
      connection: getBullMQConnection(),
      concurrency: config.verification.retryQueueConcurrency,
    }
  );

  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- the handler body is fully try/catch-wrapped, so it can never leave a rejected promise for the EventEmitter to drop.
  worker.on("completed", async (job, result) => {

    try {

      await completeVerificationItem(
        job.data.itemId,
        result,
        job.attemptsMade
      );

      await updateJobProgress(job.data.jobId);

    } catch (error) {

      console.error(
        "[VerificationWorker] Failed to persist completion:",
        error
      );

    }

  });

  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- the handler body is fully try/catch-wrapped, so it can never leave a rejected promise for the EventEmitter to drop.
  worker.on("failed", async (job, error) => {

    if (!job) {
      return;
    }

    const maxAttempts =
      typeof job.opts.attempts === "number"
        ? job.opts.attempts
        : 1;

    /*
    BullMQ emits 'failed' on every failed attempt, not only the
    final one. Only persist a terminal FAILED state once the retry
    budget is actually exhausted — earlier attempts are still
    "in flight" from the durable record's point of view.
    */

    if (job.attemptsMade < maxAttempts) {
      return;
    }

    try {

      await failVerificationItem(
        job.data.itemId,
        error,
        job.attemptsMade
      );

      await updateJobProgress(job.data.jobId);

    } catch (persistError) {

      console.error(
        "[VerificationWorker] Failed to persist failure:",
        persistError
      );

    }

  });

  worker.on("error", (error) => {

    console.error("[VerificationWorker] Worker error:", error);

  });

  return worker;

}
