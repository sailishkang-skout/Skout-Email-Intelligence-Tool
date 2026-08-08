import type {
  FastifyInstance,
} from "fastify";

import { pingDatabase } from "../database/database.js";
import { pingRedis } from "../redis/redisClient.js";
import { getQueueCounts } from "../queue/verificationQueue.js";
import { pingStorage } from "../storage/storageProvider.js";

/*
==================================================
HEALTH / LIVENESS / READINESS
==================================================

GET /health      — overall status (used by humans/dashboards)
GET /liveness     — is the process alive at all? Never checks
                     dependencies — a dependency outage must not
                     cause an orchestrator to kill and restart a
                     perfectly healthy process.
GET /readiness    — can this instance actually serve traffic right
                     now? Checks every dependency this service
                     cannot function without. Must return non-2xx
                     (so it's pulled from the load balancer) if any
                     of them are unreachable.
==================================================
*/

interface HealthCheckResult {
  status: "ok" | "error";
  latencyMs: number;
  error?: string;
}

async function checkDatabase(): Promise<HealthCheckResult> {
  const start = Date.now();

  const ok = await pingDatabase();

  return ok
    ? { status: "ok", latencyMs: Date.now() - start }
    : { status: "error", latencyMs: Date.now() - start, error: "PostgreSQL unreachable" };
}

async function checkRedis(): Promise<HealthCheckResult> {
  const start = Date.now();

  const ok = await pingRedis();

  return ok
    ? { status: "ok", latencyMs: Date.now() - start }
    : { status: "error", latencyMs: Date.now() - start, error: "Redis unreachable" };
}

async function checkQueue(): Promise<HealthCheckResult> {
  const start = Date.now();

  try {
    await getQueueCounts();
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (error: unknown) {
    return {
      status: "error",
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkStorage(): Promise<HealthCheckResult> {
  const start = Date.now();

  const ok = await pingStorage();

  return ok
    ? { status: "ok", latencyMs: Date.now() - start }
    : { status: "error", latencyMs: Date.now() - start, error: "Object storage unreachable" };
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

    const [database, redis, queue] = await Promise.all([
      checkDatabase(),
      checkRedis(),
      checkQueue(),
    ]);

    const ready =
      database.status === "ok" &&
      redis.status === "ok" &&
      queue.status === "ok";

    return reply
      .code(ready ? 200 : 503)
      .send({
        status: ready ? "ready" : "not_ready",
        timestamp: new Date().toISOString(),
        checks: { database, redis, queue },
      });

  });

  app.get("/health", async (_request, reply) => {

    const [database, redis, queue, storage] = await Promise.all([
      checkDatabase(),
      checkRedis(),
      checkQueue(),
      checkStorage(),
    ]);

    /*
    Storage is intentionally excluded from the pass/fail
    determination: no route currently depends on it (see
    storageProvider.ts), so a storage outage should be visible here
    for operator awareness without marking otherwise-healthy
    instances unhealthy.
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
        checks: { database, redis, queue, storage },
      });
  });
}
