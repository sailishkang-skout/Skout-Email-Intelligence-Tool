import "./observability/tracing.js";

import { startVerificationQueueWorker } from "./queue/verificationQueueWorker.js";
import { closeVerificationQueue } from "./queue/verificationQueue.js";
import { closeDatabase } from "./database/database.js";
import { closeRedis, getBullMQWorkerConnection } from "./redis/redisClient.js";
import { runMigrations } from "./database/migrations.js";
import { getDatabase } from "./database/database.js";
import { shutdownTracing } from "./observability/tracing.js";
import { startWorkerHeartbeat } from "./queue/workerHeartbeat.js";
import { startOutboxDispatcher } from "./queue/outboxDispatcher.js";
import { startWorkerLivenessMonitor } from "./queue/workerLivenessMonitor.js";
import { startJobItemReconciler } from "./queue/jobItemReconciler.js";

/*
==================================================
WORKER PROCESS ENTRY POINT
==================================================

Standalone process that consumes the durable
verification queue. Scales independently from the
API process (see docker-compose.yml: `api` and
`worker` are separate services/containers).
==================================================
*/

await runMigrations(getDatabase());

const { worker, waitForPendingHandlers } = startVerificationQueueWorker();

console.log(
  `Verification queue worker started (concurrency configured via VERIFICATION_QUEUE_CONCURRENCY)`
);

const stopHeartbeat = startWorkerHeartbeat(worker, getBullMQWorkerConnection());

// Drives the transactional outbox (see src/queue/outboxDispatcher.ts):
// polls Postgres for durably-accepted batch items and enqueues them
// into BullMQ, independent of the API process. Runs alongside the
// worker rather than as its own process - it needs no dedicated
// scaling and this avoids introducing a third deployable.
const outboxDispatcher = startOutboxDispatcher();

// Self-heals a known BullMQ/ioredis reconnect edge case where the
// Worker's consume loop can get permanently stuck after a real Redis
// outage-and-reconnect cycle, even though the connection itself
// reports healthy - see workerLivenessMonitor.ts for the full story
// and why exiting (relying on Docker's restart: unless-stopped) is
// the right recovery rather than trying to nudge BullMQ internals.
const stopLivenessMonitor = startWorkerLivenessMonitor(worker).stop;

// Backstop for a narrow BullMQ/Postgres consistency gap: a worker
// process killed between BullMQ recording a job's completed/failed
// outcome and our own event listener's Postgres write finishing
// leaves verification_job_items stuck at PROCESSING forever (BullMQ
// never redelivers a job it already considers terminal). See the
// STALE PROCESSING ITEM RECOVERY doc comment in
// verificationJobService.ts for the full reasoning.
const jobItemReconciler = startJobItemReconciler();

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {

  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(`[Worker] Received ${signal}, shutting down gracefully...`);

  // Stop refreshing the heartbeat immediately so Docker's healthcheck
  // starts going stale (and eventually reports unhealthy) right away
  // during a graceful shutdown, rather than only detecting problems
  // after a crash.
  stopHeartbeat();
  stopLivenessMonitor();

  try {
    // Stops claiming new outbox rows and waits for any in-flight
    // claim's transaction to commit/rollback, so shutdown never
    // abandons a claimed row mid-dispatch.
    await outboxDispatcher.stop();
  } catch (error) {
    console.error("[Worker] Error while stopping outbox dispatcher:", error);
  }

  try {
    await jobItemReconciler.stop();
  } catch (error) {
    console.error("[Worker] Error while stopping job item reconciler:", error);
  }

  try {
    // Waits for in-flight jobs to finish (or the default 30s grace
    // period) before closing, so a deploy never kills a job mid-SMTP-
    // transaction and leaves it stuck in PROCESSING.
    await worker.close();
  } catch (error) {
    console.error("[Worker] Error while closing worker:", error);
  }

  try {
    // worker.close() only waits for the active job PROCESSOR to
    // return - it does not wait for the "completed"/"failed" event
    // listeners (which persist the result to Postgres) to finish
    // their own async work. Closing Redis/Postgres before those
    // listeners finish can tear the connection down mid-write,
    // silently leaving a job's aggregate status stuck (confirmed
    // live via a SIGTERM race - see verificationQueueWorker.ts).
    await waitForPendingHandlers();
  } catch (error) {
    console.error("[Worker] Error while waiting for pending completion handlers:", error);
  }

  try {
    await closeVerificationQueue();
  } catch (error) {
    console.error("[Worker] Error while closing queue:", error);
  }

  try {
    await closeRedis();
  } catch (error) {
    console.error("[Worker] Error while closing Redis:", error);
  }

  try {
    await closeDatabase();
  } catch (error) {
    console.error("[Worker] Error while closing database:", error);
  }

  try {
    await shutdownTracing();
  } catch (error) {
    console.error("[Worker] Error while shutting down tracing:", error);
  }

  process.exit(0);

}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
