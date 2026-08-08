import { Queue, QueueEvents } from "bullmq";

import { getBullMQConnection } from "../redis/redisClient.js";

/*
==================================================
VERIFICATION QUEUE
==================================================

Purpose:

The single canonical durable queue for asynchronous
verification work. One BullMQ job per email item in
a batch verification job (see verificationJobService
for the durable Postgres record those items belong
to).

There must be exactly one queue architecture in this
service — do not add a second, competing job system
alongside this one.
==================================================
*/

export const VERIFICATION_QUEUE_NAME = "verification";

export interface VerificationJobPayload {
  itemId: string;
  jobId: string;
  email: string;
}

let queue: Queue<VerificationJobPayload> | null = null;

export function getVerificationQueue(): Queue<VerificationJobPayload> {

  if (!queue) {

    queue = new Queue<VerificationJobPayload>(
      VERIFICATION_QUEUE_NAME,
      {
        connection: getBullMQConnection(),
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: "exponential",
            delay: 30_000, // 30s, 60s, 120s
          },
          // Keep a bounded window of completed/failed jobs for
          // observability without letting Redis grow unbounded.
          removeOnComplete: { count: 1000, age: 24 * 60 * 60 },
          removeOnFail: { count: 5000, age: 7 * 24 * 60 * 60 },
        },
      }
    );

  }

  return queue;

}

/**
 * Enqueues one verification job per item. Using the item's own id
 * as the BullMQ jobId makes enqueue idempotent — re-enqueuing the
 * same item (e.g. an API retry that re-runs job creation) is a
 * no-op rather than a duplicate job.
 */
export async function enqueueVerificationItem(
  payload: VerificationJobPayload
): Promise<void> {

  await getVerificationQueue().add(
    "verify-email",
    payload,
    {
      jobId: payload.itemId,
    }
  );

}

let queueEvents: QueueEvents | null = null;

export function getVerificationQueueEvents(): QueueEvents {

  if (!queueEvents) {

    queueEvents = new QueueEvents(
      VERIFICATION_QUEUE_NAME,
      { connection: getBullMQConnection() }
    );

  }

  return queueEvents;

}

export async function getQueueCounts(): Promise<{
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
}> {

  const counts = await getVerificationQueue().getJobCounts(
    "waiting",
    "active",
    "delayed",
    "failed",
    "completed"
  );

  return {
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    delayed: counts.delayed ?? 0,
    failed: counts.failed ?? 0,
    completed: counts.completed ?? 0,
  };

}

export async function closeVerificationQueue(): Promise<void> {

  if (queue) {
    await queue.close();
    queue = null;
  }

  if (queueEvents) {
    await queueEvents.close();
    queueEvents = null;
  }

}
