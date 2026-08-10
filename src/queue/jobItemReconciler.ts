import type { PoolClient } from "pg";

import {
  claimStaleProcessingItems,
  commitProcessingItemsClaim,
  rollbackProcessingItemsClaim,
  markStaleItemCompletedFromPersistedResult,
  markStaleItemFailedFromBullMQState,
  touchUnresolvedStaleItem,
  updateJobProgress,
  type ClaimedStaleProcessingItem,
} from "../services/verificationJobService.js";

import {
  VerificationRepository,
  type VerificationResultRecord,
} from "../repositories/verificationRepository.js";

import {
  findVerificationDecisionByVerificationId,
  type VerificationDecisionRecord,
} from "../repositories/verificationDecisionRepository.js";

import { getVerificationQueue } from "./verificationQueue.js";

import { extractErrorMessage } from "../utils/errorMessage.js";

/*
==================================================
JOB ITEM RECONCILER
==================================================

Purpose:

Backstop for a narrow, confirmed BullMQ/Postgres
consistency gap: BullMQ's "completed"/"failed" events
are not awaited by BullMQ itself, so a worker process
killed (SIGKILL/OOM) between BullMQ recording a job's
outcome and our own listener's Postgres write finishing
leaves verification_job_items.status stuck at
PROCESSING forever - BullMQ never redelivers a job it
already considers completed or failed. See the
STALE PROCESSING ITEM RECOVERY doc comment in
verificationJobService.ts for the full reasoning,
including why re-enqueuing the same itemId cannot fix
this (BullMQ's custom-jobId add() is a no-op once a job
with that id exists in any terminal state).

This is a rare-path backstop, not a hot path - polls
infrequently and only ever touches items that have been
PROCESSING for far longer than any legitimate
verifyEmail() call (worst case ~60-65s - see
JOB_LOCK_DURATION_MS's derivation in
verificationQueueWorker.ts) or BullMQ's own stalled-job
recovery (lockDuration + stalledInterval, ~150s) could
ever take, so it cannot mistake a genuinely active item
for a stuck one.
==================================================
*/

const BATCH_SIZE = 10;
const POLL_INTERVAL_MS = 60_000;
const DRAIN_DELAY_MS = 1_000;

// Safely beyond verifyEmail()'s ~60-65s worst case AND BullMQ's own
// stalled-job recovery cycle (lockDuration 120s + stalledInterval
// 30s, ~150s) - by the time an item qualifies here, it is not merely
// slow, and BullMQ's own machinery has already had every opportunity
// to redeliver it on its own if it were going to.
const STALE_PROCESSING_THRESHOLD_MS = 5 * 60_000;

const verificationRepository = new VerificationRepository();

function buildReconciledResultJson(
  result: VerificationResultRecord,
  decision: VerificationDecisionRecord | null
): Record<string, unknown> {

  return {
    success: true,
    reconciled: true,
    reconciledReason:
      "worker process terminated after the verification result was durably persisted but before job-item completion was recorded; recovered from the persisted verification_results/verification_decisions rows instead of re-verifying",
    verificationId: result.verification_id,
    email: result.email,
    domain: result.domain,
    requestId: result.request_id,
    pattern: result.pattern,
    verificationStatus: result.verification_status,
    decision: result.decision,
    recommendation: result.recommendation,
    confidence: {
      score: result.confidence_score,
      level: result.confidence_level,
    },
    smtp: {
      provider: result.provider,
      responseCode: result.response_code,
      responseMessage: result.response_message,
      smtpValid: result.smtp_valid,
      mailboxExists: result.mailbox_exists,
      mxAvailable: result.mx_available,
      retryRequired: result.retry_required,
      retryReason: result.retry_reason,
    },
    catchAll: result.catch_all,
    evidenceSnapshot: decision?.evidenceSnapshot ?? null,
  };

}

type ReconcileOutcome = "recovered" | "failed" | "skipped-active" | "unresolved";

async function reconcileRow(
  client: PoolClient,
  row: ClaimedStaleProcessingItem
): Promise<ReconcileOutcome> {

  // verificationId === itemId for every item processed through the
  // async worker (see verificationQueueWorker.ts's processVerificationJob).
  const persistedResult = await verificationRepository.findByVerificationId(row.id);

  if (persistedResult) {

    const persistedDecision = await findVerificationDecisionByVerificationId(row.id);

    await markStaleItemCompletedFromPersistedResult(
      client,
      row.id,
      buildReconciledResultJson(persistedResult, persistedDecision)
    );

    console.log(
      `[JobItemReconciler] Recovered item ${row.id}: found a durably persisted verification_results row while PROCESSING was stale, marked COMPLETED without re-verifying (likely a worker crash between BullMQ completing the job and the completion listener's Postgres write).`
    );

    return "recovered";

  }

  const job = await getVerificationQueue().getJob(row.id);

  if (!job) {

    console.error(
      `[JobItemReconciler] Item ${row.id} has been PROCESSING for longer than ${STALE_PROCESSING_THRESHOLD_MS}ms with no persisted verification_results row and no matching BullMQ job. Deferring it (not resolved) pending manual investigation - this should not happen given BullMQ's retention windows (removeOnComplete/removeOnFail) far exceed this staleness threshold.`
    );

    await touchUnresolvedStaleItem(client, row.id, STALE_PROCESSING_THRESHOLD_MS);

    return "unresolved";

  }

  if (await job.isCompleted()) {

    console.error(
      `[JobItemReconciler] Data integrity alarm: BullMQ job ${row.id} is COMPLETED but no verification_results row exists for it. The atomic result/decision transaction in emailVerificationOrchestrator.ts should make this impossible. Deferring it (not resolved) pending manual investigation rather than guessing.`
    );

    await touchUnresolvedStaleItem(client, row.id, STALE_PROCESSING_THRESHOLD_MS);

    return "unresolved";

  }

  if (await job.isFailed()) {

    await markStaleItemFailedFromBullMQState(
      client,
      row.id,
      job.failedReason ??
        "BullMQ exhausted all retry attempts (reconciled after a worker crash lost the original failure write)"
    );

    console.log(
      `[JobItemReconciler] Reconciled item ${row.id} as FAILED: BullMQ confirms the underlying job exhausted its retries, but the failure was never recorded in Postgres (likely a worker crash between BullMQ failing the job and the failure listener's write).`
    );

    return "failed";

  }

  // Still active/waiting/delayed - genuinely in flight or legitimately
  // scheduled for a BullMQ-owned retry, not actually stuck.
  return "skipped-active";

}

export interface ReconcileBatchResult {
  recovered: number;
  failed: number;
  skipped: number;
  unresolved: number;
  hadFullBatch: boolean;
}

/**
 * Claims and reconciles a single batch of stale PROCESSING items.
 * Exported separately from startJobItemReconciler() so tests can
 * drive one deterministic pass instead of racing a timer loop.
 */
export async function reconcileStaleProcessingItemsBatch(): Promise<ReconcileBatchResult> {

  const claim = await claimStaleProcessingItems(BATCH_SIZE, STALE_PROCESSING_THRESHOLD_MS);

  if (claim.rows.length === 0) {
    await commitProcessingItemsClaim(claim.client);
    return { recovered: 0, failed: 0, skipped: 0, unresolved: 0, hadFullBatch: false };
  }

  let recovered = 0;
  let failed = 0;
  let skipped = 0;
  let unresolved = 0;
  let releaseMode: "commit" | "rollback" = "commit";

  const jobIdsToUpdate = new Set<string>();

  try {

    for (const row of claim.rows) {

      const outcome = await reconcileRow(claim.client, row);

      switch (outcome) {
        case "recovered":
          recovered += 1;
          jobIdsToUpdate.add(row.jobId);
          break;
        case "failed":
          failed += 1;
          jobIdsToUpdate.add(row.jobId);
          break;
        case "skipped-active":
          skipped += 1;
          break;
        case "unresolved":
          unresolved += 1;
          break;
      }

    }

  } catch (error) {

    // Should not happen - each branch of reconcileRow() handles its
    // own errors as far as reasonably possible. If something outside
    // that throws anyway, abort the whole claimed batch rather than
    // committing a partially-applied, unknown state; every row in it
    // is still genuinely PROCESSING and will be reconsidered next poll.
    releaseMode = "rollback";

    console.error(
      "[JobItemReconciler] Unexpected error while reconciling a claimed batch:",
      extractErrorMessage(error)
    );

  }

  if (releaseMode === "commit") {
    await commitProcessingItemsClaim(claim.client);
  } else {
    await rollbackProcessingItemsClaim(claim.client);
    jobIdsToUpdate.clear();
  }

  for (const jobId of jobIdsToUpdate) {

    await updateJobProgress(jobId).catch(error => {
      console.error(
        `[JobItemReconciler] Failed to update job progress for ${jobId} after reconciliation:`,
        extractErrorMessage(error)
      );
    });

  }

  return {
    recovered,
    failed,
    skipped,
    unresolved,
    hadFullBatch: claim.rows.length === BATCH_SIZE,
  };

}

export interface JobItemReconcilerHandle {
  stop: () => Promise<void>;
}

/**
 * Starts the background polling loop. Infrequent by design (this is
 * a rare-path backstop, not a dispatch mechanism) - drains slightly
 * faster only when a batch comes back full, on the assumption there
 * may be more backlog. stop() waits for any in-flight batch to finish
 * committing/rolling back before resolving, so shutdown never
 * abandons a claimed transaction.
 */
export function startJobItemReconciler(): JobItemReconcilerHandle {

  let stopped = false;
  let wake: (() => void) | null = null;

  function sleep(ms: number): Promise<void> {

    return new Promise((resolve) => {

      const timer = setTimeout(resolve, ms);
      timer.unref();

      wake = () => {
        clearTimeout(timer);
        resolve();
      };

    });

  }

  async function runLoop(): Promise<void> {

    while (!stopped) {

      let hadFullBatch = false;

      try {

        const result = await reconcileStaleProcessingItemsBatch();
        hadFullBatch = result.hadFullBatch;

      } catch (error) {

        console.error(
          "[JobItemReconciler] Poll tick failed:",
          extractErrorMessage(error)
        );

      }

      if (stopped) {
        break;
      }

      await sleep(hadFullBatch ? DRAIN_DELAY_MS : POLL_INTERVAL_MS);

    }

  }

  const loopPromise = runLoop();

  return {

    stop: async () => {

      stopped = true;

      if (wake) {
        wake();
      }

      await loopPromise;

    },

  };

}
