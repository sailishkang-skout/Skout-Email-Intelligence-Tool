import { Worker, type Job } from "bullmq";

import { getBullMQWorkerConnection } from "../redis/redisClient.js";
import { config } from "../config/config.js";

import {
  VERIFICATION_QUEUE_NAME,
  type VerificationJobPayload,
} from "./verificationQueue.js";

import { verifyEmail } from "../services/emailVerificationOrchestrator.js";

import {
  markJobRunning,
  markItemProcessing,
  completeVerificationItem,
  failVerificationItem,
  updateJobProgress,
  getVerificationJobItemStatus,
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

/*
==================================================
STALL-DETECTION SAFETY MARGIN
==================================================

Why this exists:

BullMQ auto-renews an active job's lock at
lockDuration/2 (bullmq's own default renewal
cadence) and only redelivers a job once the stalled
checker (every `stalledInterval`ms) observes an
expired, un-renewed lock. Under BullMQ's own
defaults (lockDuration: 30000), that renewal has to
succeed roughly every 15s - fine for a fast job, but
this worker's single processor call
(verifyEmail -> real SMTP work) can legitimately run
much longer than that, and a transient Redis hiccup
(the exact kind of instability this whole project
hardens against) landing during a renewal attempt is
exactly the scenario that could delay a renewal past
the deadline. If that happens, BullMQ would
redeliver a job that's still genuinely, correctly
in-flight - the worker-side duplicate-processing
guard in processVerificationJob() deliberately does
NOT block on a merely-PROCESSING item (that's what
lets real crash recovery work), so a false stall
here would cause a second, real, concurrent SMTP
verification for the same item.

Actual worst-case verifyEmail() duration, computed
from the real per-stage bounds (see
smtpConnection.ts and catchAllChecker.ts):

  - MX/DNS lookup:            a few seconds, generously
  - verifySMTP (primary MX):  one SMTPConnection,
                               hardTimeoutMs = 10_000 * 3 = 30_000ms
  - checkCatchAll:             one more SMTPConnection,
                               timeoutMs: 10_000 -> hardTimeoutMs 30_000ms
  - verification-event Postgres writes scattered
    throughout: negligible (single-digit ms each)

  Worst case: ~60-65 seconds (both SMTP connections
  hitting their full hard deadlines sequentially).

lockDuration below is set to comfortably exceed that
(~2x), so even a delayed renewal cycle during a
genuinely slow-but-healthy verification has ample
margin before BullMQ would ever consider it stalled.
This does NOT slow down detecting a truly crashed
worker in the common case - a crashed worker stops
renewing entirely, so it's still found by the next
stalledInterval check after lockDuration elapses;
this only widens the window for a HEALTHY, still-
running job to survive a renewal hiccup.
==================================================
*/
export const JOB_LOCK_DURATION_MS = 120_000; // ~2x the ~60-65s worst-case verifyEmail() duration
export const JOB_STALLED_CHECK_INTERVAL_MS = 30_000; // BullMQ default - frequent enough to notice a genuinely dead worker promptly
export const JOB_MAX_STALLED_COUNT = 1; // BullMQ default, made explicit

/*
Distinguishes a deliberately-skipped duplicate delivery from a real
verification result, so the "completed" listener below knows not to
re-persist (and clobber) an already-terminal item's result_json.
*/
export interface SkippedDuplicateResult {
  skipped: true;
  reason: "already-terminal";
  status: "COMPLETED" | "FAILED";
}

function isSkippedDuplicateResult(
  value: unknown
): value is SkippedDuplicateResult {

  return (
    typeof value === "object" &&
    value !== null &&
    (value as { skipped?: unknown }).skipped === true
  );

}

/*
Guards against running a real SMTP verification twice for the same
item: BullMQ redelivers jobs (stalled-job recovery, at-least-once
delivery) and the outbox dispatcher can retry an enqueue whose
underlying add() already went through - both are expected and safe
AS LONG AS this check exists, because an item only ever reaches
COMPLETED/FAILED once, via the event listeners below. PROCESSING and
PENDING are deliberately NOT treated as terminal - a job stuck
mid-attempt (e.g. a worker that crashed after verifying but before
persisting) must still be allowed to run again.
*/
export async function processVerificationJob(
  job: Job<VerificationJobPayload>
): Promise<unknown> {

  const currentStatus = await getVerificationJobItemStatus(job.data.itemId);

  if (currentStatus === "COMPLETED" || currentStatus === "FAILED") {

    console.log(
      `[VerificationWorker] Skipping item ${job.data.itemId} - already ${currentStatus} (duplicate/redelivered job, no second SMTP verification)`
    );

    const result: SkippedDuplicateResult = {
      skipped: true,
      reason: "already-terminal",
      status: currentStatus,
    };

    return result;

  }

  /*
  markJobRunning()'s own WHERE clause (status IN ('PENDING','RUNNING'))
  is what makes this race-safe on its own, without needing any lock
  here: it can only ever move a job forward from PENDING into RUNNING,
  never backward from a terminal COMPLETED/FAILED/CANCELLED state, no
  matter how many times or in what order concurrent items of the same
  job call it.
  */
  await markJobRunning(job.data.jobId);

  await markItemProcessing(job.data.itemId);

  /*
  Passes the job item's own id as verifyEmail()'s verificationId
  instead of letting it mint a fresh one per attempt. verification_
  results/verification_decisions now persist atomically and upsert
  on verificationId (see emailVerificationOrchestrator.ts) - reusing
  the item's stable id means a BullMQ redelivery/retry of this same
  logical item (attempts: 3 - see verificationQueue.ts) converges on
  the same rows instead of leaving an orphaned attempt behind and
  losing the ability to tell two attempts at the same item apart.
  */
  return verifyEmail(job.data.email, { verificationId: job.data.itemId });

}

export interface VerificationQueueWorkerHandle {
  worker: Worker<VerificationJobPayload>;

  /*
  BullMQ's worker.close() resolves once the active job PROCESSOR
  function returns - it does not wait for the "completed"/"failed"
  EVENT LISTENERS below (registered separately via worker.on) to
  finish their own async work. Those listeners are what actually
  persist completion/failure to Postgres, so closing the database
  pool immediately after worker.close() can tear it down while a
  listener is mid-write.

  Confirmed live: a SIGTERM during an in-flight job let
  completeVerificationItem() succeed but killed the pool before the
  very next line, updateJobProgress(), could run - the item persisted
  correctly but the job's aggregate status was silently left stuck at
  RUNNING forever, even though the underlying error was logged (and
  swallowed) by the handler's own try/catch.

  waitForPendingHandlers() lets shutdown sequences wait for every
  currently in-flight completed/failed listener to fully finish
  before closing Redis/Postgres.
  */
  waitForPendingHandlers: () => Promise<void>;
}

export function startVerificationQueueWorker(): VerificationQueueWorkerHandle {

  const worker = new Worker<VerificationJobPayload>(
    VERIFICATION_QUEUE_NAME,
    processVerificationJob,
    {
      connection: getBullMQWorkerConnection(),
      concurrency: config.verification.retryQueueConcurrency,
      lockDuration: JOB_LOCK_DURATION_MS,
      stalledInterval: JOB_STALLED_CHECK_INTERVAL_MS,
      maxStalledCount: JOB_MAX_STALLED_COUNT,
    }
  );

  const pendingHandlers = new Set<Promise<void>>();

  function track(promise: Promise<void>): void {

    pendingHandlers.add(promise);

    void promise.finally(() => {
      pendingHandlers.delete(promise);
    });

  }

  worker.on("completed", (job, result) => {

    if (isSkippedDuplicateResult(result)) {
      // Already persisted as terminal by whichever attempt actually
      // ran verifyEmail() - nothing to do here.
      return;
    }

    track((async () => {

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

    })());

  });

  worker.on("failed", (job, error) => {

    if (!job) {
      return;
    }

    track((async () => {

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

    })());

  });

  worker.on("error", (error) => {

    console.error("[VerificationWorker] Worker error:", error);

  });

  return {

    worker,

    waitForPendingHandlers: async () => {

      await Promise.all(pendingHandlers);

    },

  };

}
