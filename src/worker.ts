import "./observability/tracing.js";

import { startVerificationQueueWorker } from "./queue/verificationQueueWorker.js";
import { closeVerificationQueue } from "./queue/verificationQueue.js";
import { closeDatabase } from "./database/database.js";
import { closeRedis } from "./redis/redisClient.js";
import { runMigrations } from "./database/migrations.js";
import { getDatabase } from "./database/database.js";
import { shutdownTracing } from "./observability/tracing.js";

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

const worker = startVerificationQueueWorker();

console.log(
  `Verification queue worker started (concurrency configured via VERIFICATION_QUEUE_CONCURRENCY)`
);

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {

  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(`[Worker] Received ${signal}, shutting down gracefully...`);

  try {
    // Waits for in-flight jobs to finish (or the default 30s grace
    // period) before closing, so a deploy never kills a job mid-SMTP-
    // transaction and leaves it stuck in PROCESSING.
    await worker.close();
  } catch (error) {
    console.error("[Worker] Error while closing worker:", error);
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
