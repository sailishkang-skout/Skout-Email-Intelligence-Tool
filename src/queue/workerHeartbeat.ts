import fs from "node:fs";
import path from "node:path";

import type { Worker } from "bullmq";
import type { Redis } from "ioredis";

/*
==================================================
WORKER HEARTBEAT
==================================================

Purpose:

The worker process has no HTTP server - it is a
lean BullMQ consumer, and adding one purely to
satisfy Docker's HEALTHCHECK would be unnecessary
infrastructure for a process that otherwise needs
none. Docker's HEALTHCHECK previously reused the API
image's HTTP-based check (fetch .../liveness), which
can never succeed here since nothing listens on that
port in this process - not a bug in the worker
itself, just a healthcheck checking for something
that structurally cannot exist in this container.

This is a file-based readiness signal instead: while
the worker is genuinely healthy (BullMQ Worker
running and unpaused, underlying Redis connection
"ready"), it periodically touches a heartbeat file.
Docker's healthcheck command (see docker-compose.yml)
checks that the file exists and was updated recently.
A worker that stops updating it - because it hung,
lost its Redis connection, or was paused - goes stale
and Docker correctly reports it as unhealthy within
one or two check cycles.

This intentionally reads the ALREADY-RUNNING worker's
own live state (isRunning()/isPaused(), the real
connection .status) rather than opening a fresh,
independent Redis connection each check - a fresh
ping could succeed even if the actual worker instance
were stuck, defeating the point of checking readiness
rather than raw network reachability.
==================================================
*/

const HEARTBEAT_DIR =
  process.env.WORKER_HEARTBEAT_DIR ?? "/tmp/worker-health";

const HEARTBEAT_FILE =
  path.join(HEARTBEAT_DIR, "ready");

const HEARTBEAT_INTERVAL_MS = 5_000;

export function startWorkerHeartbeat(
  worker: Worker,
  redisConnection: Redis
): () => void {

  fs.mkdirSync(HEARTBEAT_DIR, { recursive: true });

  const writeHeartbeat = () => {

    const healthy =
      worker.isRunning() &&
      !worker.isPaused() &&
      redisConnection.status === "ready";

    if (!healthy) {
      return;
    }

    try {
      fs.writeFileSync(HEARTBEAT_FILE, String(Date.now()));
    } catch (error) {
      console.error(
        "[WorkerHeartbeat] Failed to write heartbeat file:",
        error
      );
    }

  };

  writeHeartbeat();

  const timer = setInterval(writeHeartbeat, HEARTBEAT_INTERVAL_MS);
  timer.unref();

  return () => {
    clearInterval(timer);
  };

}
