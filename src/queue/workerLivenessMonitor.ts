import type { Worker } from "bullmq";

import { getQueueCounts } from "./verificationQueue.js";
import { extractErrorMessage } from "../utils/errorMessage.js";

/*
==================================================
WORKER LIVENESS MONITOR
==================================================

Purpose:

Confirmed live during a production-hardening pass,
against real Docker: after a real Redis
outage-and-reconnect cycle (specifically one involving
DNS resolution failures - `getaddrinfo ENOTFOUND redis`,
as opposed to `ECONNREFUSED`), a BullMQ Worker's
internal blocking-consume loop can get permanently
stuck - never picking up another job - while its own
connection's `.status` still correctly reports "ready"
and worker.isRunning()/isPaused() both report healthy.
This is a real gap in BullMQ/ioredis's own reconnect
handling, not something fixable by changing how this
codebase calls those libraries. A freshly-restarted
worker process, identical code, immediately resumed
consuming - proving the stuck state belongs to that one
Worker instance, not a deeper logic bug reachable
through normal operation.

Since the existing heartbeat (workerHeartbeat.ts) can't
detect this - it deliberately checks the worker's own
reported state, which is exactly what's wrong here -
this is a SEPARATE, stronger liveness signal: are jobs
actually being picked up when there's a real backlog to
pick up? If the BullMQ 'active' event (fires whenever
the worker's consume loop actually claims a job) hasn't
fired in STALL_THRESHOLD_MS while the queue has a
non-empty backlog, the consume loop is presumed stuck.

Recovery: this module does NOT try to nudge/recreate
the stuck Worker in place (poking at BullMQ/ioredis
internals directly would be fragile and version-coupled).
Instead it exits the process, relying on the EXISTING
`restart: unless-stopped` policy (docker-compose.yml)
to bring up a fresh instance - the exact recovery this
was empirically confirmed to fix. This reuses
infrastructure this service already depends on (BullMQ's
own APIs, Docker's own restart policy) rather than
adding anything new.
==================================================
*/

const STALL_CHECK_INTERVAL_MS = 30_000;
const STALL_THRESHOLD_MS = 90_000;
// Gives the process time to fully start up and for a genuinely empty
// queue to stay quiet without being flagged before any real backlog
// has had a chance to build up.
const STARTUP_GRACE_MS = 60_000;

export interface WorkerLivenessMonitorHandle {
  stop: () => void;
}

export interface WorkerLivenessMonitorOptions {
  checkIntervalMs?: number;
  stallThresholdMs?: number;
  startupGraceMs?: number;
  // Test seam: production always exits the process; tests substitute
  // a spy instead of actually killing the test runner.
  onStalled?: () => void;
}

export function startWorkerLivenessMonitor(
  worker: Worker,
  options: WorkerLivenessMonitorOptions = {}
): WorkerLivenessMonitorHandle {

  const checkIntervalMs = options.checkIntervalMs ?? STALL_CHECK_INTERVAL_MS;
  const stallThresholdMs = options.stallThresholdMs ?? STALL_THRESHOLD_MS;
  const startupGraceMs = options.startupGraceMs ?? STARTUP_GRACE_MS;
  const onStalled = options.onStalled ?? (() => process.exit(1));

  const startedAt = Date.now();
  let lastActiveAt = Date.now();

  worker.on("active", () => {
    lastActiveAt = Date.now();
  });

  const timer = setInterval(() => {

    void (async () => {

      if (Date.now() - startedAt < startupGraceMs) {
        return;
      }

      const idleForMs = Date.now() - lastActiveAt;

      if (idleForMs < stallThresholdMs) {
        return;
      }

      let waiting: number;

      try {
        ({ waiting } = await getQueueCounts());
      } catch (error) {
        // Can't tell right now - a Redis hiccup here is not itself
        // evidence of a stuck consumer. Try again next tick.
        console.error(
          "[WorkerLivenessMonitor] Failed to check queue depth:",
          extractErrorMessage(error)
        );
        return;
      }

      if (waiting === 0) {
        // Genuinely nothing to do - an idle worker is not a stuck one.
        return;
      }

      console.error(
        `[WorkerLivenessMonitor] No job has become active in ${Math.round(idleForMs / 1000)}s while ${waiting} job(s) are waiting - the BullMQ consume loop appears stuck (a known reconnect edge case, not a code bug reachable by retrying in place). Exiting so the container's restart policy brings up a fresh worker.`
      );

      onStalled();

    })();

  }, checkIntervalMs);

  timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
    },
  };

}
