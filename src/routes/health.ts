import type {
  FastifyInstance,
} from "fastify";

import { pingDatabase } from "../database/database.js";
import { pingRedis } from "../redis/redisClient.js";
import { getQueueCounts } from "../queue/verificationQueue.js";
import { pingStorage } from "../storage/storageProvider.js";
import { getOutboxSummary, type OutboxSummary } from "../services/verificationJobService.js";
import { extractErrorMessage } from "../utils/errorMessage.js";

/*
==================================================
HEALTH / LIVENESS / READINESS
==================================================

GET /liveness  — is the process alive at all? Never checks
                 dependencies — a dependency outage must not cause an
                 orchestrator to kill and restart a perfectly healthy
                 process.

GET /readiness — should traffic be routed to this instance right now?
                 Gated ONLY on PostgreSQL. This is deliberate, not an
                 oversight: the transactional outbox (see
                 verifyBatch.ts, verificationJobService.ts) means
                 POST /verify/batch/async and GET /verify/jobs/:jobId
                 - the durable-acceptance/status-polling core of this
                 service - only ever depend on Postgres. If readiness
                 also hard-failed on Redis, then during a Redis
                 outage EVERY replica behind a load balancer would
                 simultaneously fail readiness (a Redis outage is
                 shared infrastructure, not per-replica), pulling
                 ALL of them out of rotation and taking the entire
                 API down - the exact opposite of what the outbox
                 architecture exists to guarantee. Individual routes
                 that genuinely cannot function without Redis (POST
                 /send - see idempotency.ts) already fail fast and
                 truthfully on their own; removing the whole instance
                 from rotation doesn't make those routes safer, it
                 just also takes down the routes that don't need
                 Redis at all. Redis/queue/outbox state is still
                 reported in the response body for visibility - it
                 just doesn't gate the ready/not-ready determination.

GET /health    — full dependency status for humans/dashboards, not
                 load-balancer routing. Unlike /readiness, this DOES
                 reflect Redis/queue health in its pass/fail
                 determination, because its purpose is different:
                 "is everything actually healthy" rather than "should
                 traffic go here." The two endpoints answering
                 different questions is intentional - conflating them
                 is what caused the readiness/outbox contradiction
                 this comment exists to explain.
==================================================
*/

interface HealthCheckResult {
  status: "ok" | "error";
  latencyMs: number;
  error?: string;
}

/*
Every dependency check below gets the SAME explicit, named timeout
treatment. Previously only the queue check had one; database/redis/
storage relied entirely on their underlying client's own default
connect timeout (10s for both Postgres and Redis) - not an infinite
hang, but inconsistent, and slower than a health endpoint should ever
be. A health/readiness check's whole purpose is to report an outage
quickly; it must never itself become slow because of the outage it's
trying to report.
*/
const DATABASE_CHECK_TIMEOUT_MS = 3_000;
const REDIS_CHECK_TIMEOUT_MS = 3_000;
const QUEUE_CHECK_TIMEOUT_MS = 3_000;
const STORAGE_CHECK_TIMEOUT_MS = 3_000;
const OUTBOX_CHECK_TIMEOUT_MS = 3_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {

  return new Promise<T>((resolve, reject) => {

    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
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

async function checkDatabase(): Promise<HealthCheckResult> {
  const start = Date.now();

  try {
    const ok = await withTimeout(pingDatabase(), DATABASE_CHECK_TIMEOUT_MS, "Database ping");
    return ok
      ? { status: "ok", latencyMs: Date.now() - start }
      : { status: "error", latencyMs: Date.now() - start, error: "PostgreSQL unreachable" };
  } catch (error: unknown) {
    return { status: "error", latencyMs: Date.now() - start, error: extractErrorMessage(error) };
  }
}

async function checkRedis(): Promise<HealthCheckResult> {
  const start = Date.now();

  try {
    const ok = await withTimeout(pingRedis(), REDIS_CHECK_TIMEOUT_MS, "Redis ping");
    return ok
      ? { status: "ok", latencyMs: Date.now() - start }
      : { status: "error", latencyMs: Date.now() - start, error: "Redis unreachable" };
  } catch (error: unknown) {
    return { status: "error", latencyMs: Date.now() - start, error: extractErrorMessage(error) };
  }
}

// getQueueCounts() runs on BullMQ's Redis connection, which BullMQ
// requires to be configured with maxRetriesPerRequest: null (retry
// forever) so its own blocking commands work correctly - see
// redisClient.ts. That means a Redis outage leaves the underlying
// command retrying indefinitely, with no built-in bound of its own -
// this check's timeout is what actually stops it from hanging.
async function checkQueue(): Promise<HealthCheckResult> {
  const start = Date.now();

  try {
    await withTimeout(getQueueCounts(), QUEUE_CHECK_TIMEOUT_MS, "Queue status check");
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (error: unknown) {
    return {
      status: "error",
      latencyMs: Date.now() - start,
      error: extractErrorMessage(error),
    };
  }
}

async function checkStorage(): Promise<HealthCheckResult> {
  const start = Date.now();

  try {
    const ok = await withTimeout(pingStorage(), STORAGE_CHECK_TIMEOUT_MS, "Storage ping");
    return ok
      ? { status: "ok", latencyMs: Date.now() - start }
      : { status: "error", latencyMs: Date.now() - start, error: "Object storage unreachable" };
  } catch (error: unknown) {
    return { status: "error", latencyMs: Date.now() - start, error: extractErrorMessage(error) };
  }
}

interface OutboxCheckResult extends HealthCheckResult {
  summary?: OutboxSummary;
}

/*
Deliberately excluded from every pass/fail determination below (see
checkOutbox's callers) - a non-zero FAILED count or a growing backlog
is real, operator-worthy information, but it is not the same question
as "is this Postgres-only endpoint able to accept requests right
now," and flapping /health's status code based on backlog size would
make it noisier, not more useful. This is purely the visibility half
required by this hardening pass - see recoverFailedOutboxRows() in
verificationJobService.ts for the recovery half.
*/
async function checkOutbox(): Promise<OutboxCheckResult> {
  const start = Date.now();

  try {
    const summary = await withTimeout(getOutboxSummary(), OUTBOX_CHECK_TIMEOUT_MS, "Outbox summary");
    return { status: "ok", latencyMs: Date.now() - start, summary };
  } catch (error: unknown) {
    return { status: "error", latencyMs: Date.now() - start, error: extractErrorMessage(error) };
  }
}

export default async function healthRoutes(
  app: FastifyInstance
): Promise<void> {

  app.get("/liveness", async (_request, reply) => {
    return reply.code(200).send({
      status: "alive",
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/readiness", async (_request, reply) => {

    const [database, redis, queue, outbox] = await Promise.all([
      checkDatabase(),
      checkRedis(),
      checkQueue(),
      checkOutbox(),
    ]);

    // See the module doc comment above for why this is Postgres-only.
    const ready = database.status === "ok";

    return reply
      .code(ready ? 200 : 503)
      .send({
        status: ready ? "ready" : "not_ready",
        timestamp: new Date().toISOString(),
        checks: { database, redis, queue, outbox },
      });

  });

  app.get("/health", async (_request, reply) => {

    const [database, redis, queue, storage, outbox] = await Promise.all([
      checkDatabase(),
      checkRedis(),
      checkQueue(),
      checkStorage(),
      checkOutbox(),
    ]);

    /*
    Storage and outbox backlog/failure state are intentionally
    excluded from the pass/fail determination: no route depends on
    storage synchronously, and a non-empty outbox FAILED bucket is
    real but not the same signal as "this instance is unhealthy" (see
    checkOutbox's doc comment). Both are still reported for operator
    visibility without marking an otherwise-healthy instance
    unhealthy.
    */
    const healthy =
      database.status === "ok" &&
      redis.status === "ok" &&
      queue.status === "ok";

    return reply
      .code(healthy ? 200 : 503)
      .send({
        status: healthy ? "ok" : "degraded",
        service: "email-intelligence-service",
        timestamp: new Date().toISOString(),
        checks: { database, redis, queue, storage, outbox },
      });
  });
}
