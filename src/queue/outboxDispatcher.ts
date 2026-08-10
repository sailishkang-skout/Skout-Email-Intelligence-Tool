import type { PoolClient } from "pg";

import {
  claimPendingOutboxRows,
  markOutboxDispatched,
  markOutboxFailed,
  commitOutboxClaim,
  rollbackOutboxClaim,
  type ClaimedOutboxRow,
} from "../services/verificationJobService.js";

import { enqueueVerificationItem } from "./verificationQueue.js";

import { extractErrorMessage } from "../utils/errorMessage.js";

/*
==================================================
OUTBOX DISPATCHER
==================================================

Purpose:

The other half of the transactional outbox pattern
(see 006_verification_outbox.sql and
createVerificationJob in verificationJobService.ts).
POST /verify/batch/async durably accepts a batch by
writing job + items + outbox rows in one Postgres
transaction, without touching Redis at all. This
module is what actually gets those items into BullMQ
afterward - polling Postgres for PENDING outbox rows,
claiming them with FOR UPDATE SKIP LOCKED so multiple
dispatcher instances never double-claim, and enqueuing
each one via the EXISTING enqueueVerificationItem()
(unchanged - jobId: itemId still makes re-enqueuing the
same item a BullMQ no-op, not a duplicate job).

Per-item enqueue timeout:

Bounding each enqueue attempt with a timeout here is
NOT the same bug this whole architecture replaced. The
old code raced a Promise against a timeout to decide
what to tell an HTTP caller - and lied, because the
underlying BullMQ call kept running after the timeout
"lost". Here, a timeout firing just means: stop holding
this claim's Postgres transaction/lock open any longer
waiting on a slow Redis, record it as a failed attempt
with backoff, and let the NEXT poll (from this instance
or another) retry. If the original, abandoned add() call
eventually succeeds anyway (ioredis's offline queue),
the retry's add() with the same jobId is a safe no-op.
Nothing is ever told a false result - the caller-facing
HTTP response was already sent, truthfully, before this
module ever runs.

Crash safety:

Claiming holds a Postgres transaction open across the
enqueue attempts for a batch. If the dispatcher process
dies mid-batch, Postgres drops the connection and rolls
back automatically - any rows in that batch not yet
committed as DISPATCHED simply revert to PENDING and are
picked up by the next poll. See claimPendingOutboxRows's
doc comment for why no separate lease/TTL mechanism is
needed.
==================================================
*/

const BATCH_SIZE = 10;
const POLL_INTERVAL_MS = 3_000;
const DRAIN_DELAY_MS = 100;
const ENQUEUE_ATTEMPT_TIMEOUT_MS = 5_000;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 5 * 60_000; // 5 minutes

function backoffForAttempt(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** attempts, BACKOFF_MAX_MS);
}

/*
Must clear the timer once `promise` settles on its own - otherwise a
successful (fast) enqueue still leaves a 5s timer running in the
background, whose eventual reject() (nothing is left to observe it,
since Promise.race already settled via the other branch) becomes an
unhandled promise rejection. Under Node's default
--unhandled-rejections=strict, enough of those would eventually crash
the worker process - exactly the kind of silent, delayed failure this
whole architecture exists to prevent.
*/
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {

  return new Promise<T>((resolve, reject) => {

    const timer = setTimeout(
      () => reject(new Error(`Enqueue attempt timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    timer.unref();

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );

  });

}

async function dispatchRow(
  client: PoolClient,
  row: ClaimedOutboxRow
): Promise<boolean> {

  try {

    await withTimeout(
      enqueueVerificationItem({
        itemId: row.itemId,
        jobId: row.jobId,
        email: row.email,
      }),
      ENQUEUE_ATTEMPT_TIMEOUT_MS
    );

    await markOutboxDispatched(client, row.id);

    return true;

  } catch (error) {

    console.error(
      `[OutboxDispatcher] Failed to enqueue outbox row ${row.id} (item ${row.itemId}):`,
      extractErrorMessage(error)
    );

    await markOutboxFailed(
      client,
      row.id,
      error,
      row.attempts + 1,
      backoffForAttempt(row.attempts)
    );

    return false;

  }

}

/**
 * Releases a claim exactly once, via whichever of commit/rollback is
 * appropriate. commitOutboxClaim()/rollbackOutboxClaim() ALWAYS
 * release their client (even on failure - see their doc comments), so
 * once this has been called the client must never be touched again by
 * anyone, including this function itself: if the release call throws,
 * the client is already gone (destroyed) and there is nothing further
 * to release. That failure just means none of this batch's row
 * updates persisted - every row in it is still genuinely PENDING in
 * Postgres and will be retried by the next poll (from this instance
 * or another), so nothing is lost or duplicated.
 */
async function releaseClaim(
  client: PoolClient,
  mode: "commit" | "rollback"
): Promise<void> {

  try {

    if (mode === "commit") {
      await commitOutboxClaim(client);
    } else {
      await rollbackOutboxClaim(client);
    }

  } catch (error) {

    console.error(
      `[OutboxDispatcher] Failed to ${mode} a claimed batch (safe - the connection was already released/destroyed; uncommitted rows remain PENDING and will be retried):`,
      extractErrorMessage(error)
    );

  }

}

/**
 * Claims and attempts to dispatch a single batch of pending outbox
 * rows. Exported separately from startOutboxDispatcher() so tests can
 * drive one deterministic pass instead of racing a timer loop.
 */
export async function dispatchPendingOutboxBatch(): Promise<{
  dispatched: number;
  failed: number;
  hadFullBatch: boolean;
}> {

  const claim = await claimPendingOutboxRows(BATCH_SIZE);

  if (claim.rows.length === 0) {
    await releaseClaim(claim.client, "commit");
    return { dispatched: 0, failed: 0, hadFullBatch: false };
  }

  let dispatched = 0;
  let failed = 0;
  let releaseMode: "commit" | "rollback" = "commit";

  try {

    for (const row of claim.rows) {

      const success = await dispatchRow(claim.client, row);

      if (success) {
        dispatched += 1;
      } else {
        failed += 1;
      }

    }

  } catch (error) {

    // Should never happen - dispatchRow() handles every error it can
    // encounter internally and never throws. If something outside
    // that (a genuine bug) throws here anyway, abort the transaction
    // rather than committing a partially-applied, unknown state.
    releaseMode = "rollback";

    console.error(
      "[OutboxDispatcher] Unexpected error while processing a claimed batch:",
      extractErrorMessage(error)
    );

  }

  await releaseClaim(claim.client, releaseMode);

  return {
    dispatched,
    failed,
    hadFullBatch: claim.rows.length === BATCH_SIZE,
  };

}

export interface OutboxDispatcherHandle {
  stop: () => Promise<void>;
}

/**
 * Starts the background polling loop. Polls immediately (bounded by
 * DRAIN_DELAY_MS) while a batch comes back full, on the assumption
 * there's more backlog to drain; otherwise waits POLL_INTERVAL_MS
 * before the next tick, so an idle dispatcher isn't a tight loop.
 * stop() is deterministic: it stops scheduling new work and waits for
 * any in-flight batch to finish committing/rolling back before
 * resolving, so shutdown never abandons a claimed transaction.
 */
export function startOutboxDispatcher(): OutboxDispatcherHandle {

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

        const result = await dispatchPendingOutboxBatch();
        hadFullBatch = result.hadFullBatch;

      } catch (error) {

        // dispatchPendingOutboxBatch() already handles per-row and
        // per-batch failures internally - reaching here means claiming
        // itself failed (e.g. Postgres briefly unreachable). Log and
        // keep polling rather than letting the worker process die.
        console.error(
          "[OutboxDispatcher] Poll tick failed:",
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
