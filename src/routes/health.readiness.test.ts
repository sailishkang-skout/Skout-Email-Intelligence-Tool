import { test, mock } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

/*
Regression test for the readiness/outbox-durability contradiction
found during a production-hardening audit: GET /readiness used to
hard-fail (503) whenever Redis was unreachable, even though the
transactional outbox means POST /verify/batch/async and
GET /verify/jobs/:jobId only ever depend on Postgres. Since a Redis
outage is shared infrastructure (not per-replica), that would pull
EVERY replica behind a load balancer out of rotation simultaneously
during exactly the outage this project's outbox work exists to
survive - taking down routes that don't need Redis at all, alongside
the ones that do.

/readiness must now be gated on Postgres only; /health remains the
full dependency check (used for dashboards, not routing) and keeps
failing on a Redis outage.
*/

let databaseOk = true;
let redisOk = true;

mock.module("../database/database.js", {
  namedExports: {
    pingDatabase: async () => databaseOk,
  },
});

mock.module("../redis/redisClient.js", {
  namedExports: {
    pingRedis: async () => redisOk,
  },
});

mock.module("../storage/storageProvider.js", {
  namedExports: {
    pingStorage: async () => true,
  },
});

mock.module("../queue/verificationQueue.js", {
  namedExports: {
    getQueueCounts: async () => ({ waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 }),
  },
});

mock.module("../services/verificationJobService.js", {
  namedExports: {
    getOutboxSummary: async () => ({
      pending: { count: 0, oldestAgeMs: null },
      dispatched: { count: 0, oldestAgeMs: null },
      failed: { count: 0, oldestAgeMs: null },
    }),
  },
});

const { default: healthRoutes } = await import("./health.js");

test.beforeEach(() => {
  databaseOk = true;
  redisOk = true;
});

test("GET /readiness: 200 ready when Postgres is up, even though Redis is down - the outbox's durable-acceptance path does not need Redis", async () => {
  databaseOk = true;
  redisOk = false;

  const app = Fastify({ logger: false });
  await app.register(healthRoutes);

  const res = await app.inject({ method: "GET", url: "/readiness" });
  const body = JSON.parse(res.body);

  assert.equal(res.statusCode, 200, `expected readiness to stay 200 during a Redis-only outage, got ${res.statusCode}: ${res.body}`);
  assert.equal(body.status, "ready");
  assert.equal(body.checks.redis.status, "error", "Redis's own degraded state must still be visible in the body");

  await app.close();
});

test("GET /readiness: 503 not_ready when Postgres is down, regardless of Redis", async () => {
  databaseOk = false;
  redisOk = true;

  const app = Fastify({ logger: false });
  await app.register(healthRoutes);

  const res = await app.inject({ method: "GET", url: "/readiness" });
  const body = JSON.parse(res.body);

  assert.equal(res.statusCode, 503);
  assert.equal(body.status, "not_ready");

  await app.close();
});

test("GET /readiness: 503 not_ready when both Postgres and Redis are down", async () => {
  databaseOk = false;
  redisOk = false;

  const app = Fastify({ logger: false });
  await app.register(healthRoutes);

  const res = await app.inject({ method: "GET", url: "/readiness" });

  assert.equal(res.statusCode, 503);

  await app.close();
});

test("GET /health: still reports degraded (503) on a Redis outage - full dependency check, not a routing decision", async () => {
  databaseOk = true;
  redisOk = false;

  const app = Fastify({ logger: false });
  await app.register(healthRoutes);

  const res = await app.inject({ method: "GET", url: "/health" });
  const body = JSON.parse(res.body);

  assert.equal(
    res.statusCode,
    503,
    "/health answers a different question than /readiness - it must still reflect a real Redis outage"
  );
  assert.equal(body.status, "degraded");

  await app.close();
});

test("GET /readiness and GET /health both stay 200/ok when every dependency is healthy", async () => {
  databaseOk = true;
  redisOk = true;

  const app = Fastify({ logger: false });
  await app.register(healthRoutes);

  const readiness = await app.inject({ method: "GET", url: "/readiness" });
  const health = await app.inject({ method: "GET", url: "/health" });

  assert.equal(readiness.statusCode, 200);
  assert.equal(health.statusCode, 200);

  await app.close();
});
