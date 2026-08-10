import { test, mock } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

/*
Regression test for a real bug found via live Redis-outage failure
injection: GET /health's queue check (getQueueCounts()) runs on
BullMQ's Redis connection, which BullMQ requires to be configured
with maxRetriesPerRequest: null (retry forever) so its own blocking
commands work correctly. During a real Redis outage this left the
health check hanging indefinitely (confirmed live: no response after
40+ seconds) instead of reporting degraded status quickly - exactly
backwards for an endpoint whose entire purpose is fast, bounded
failure detection for orchestrators/load balancers.

This test simulates that exact shape (a queue check that never
settles) without needing a real Redis outage, and asserts /health
still responds well within its own timeout budget.
*/

mock.module("../database/database.js", {
  namedExports: {
    pingDatabase: async () => true
  }
});

mock.module("../redis/redisClient.js", {
  namedExports: {
    pingRedis: async () => true
  }
});

mock.module("../storage/storageProvider.js", {
  namedExports: {
    pingStorage: async () => true
  }
});

mock.module("../queue/verificationQueue.js", {
  namedExports: {
    // Never resolves or rejects - mirrors a BullMQ command stuck in
    // its own infinite retry loop against an unreachable Redis.
    getQueueCounts: () => new Promise(() => {})
  }
});

mock.module("../services/verificationJobService.js", {
  namedExports: {
    getOutboxSummary: async () => ({
      pending: { count: 0, oldestAgeMs: null },
      dispatched: { count: 0, oldestAgeMs: null },
      failed: { count: 0, oldestAgeMs: null },
    })
  }
});

const { default: healthRoutes } = await import("./health.js");

test("GET /health does not hang when the queue check never settles (bounded, degraded response instead)", async () => {
  const app = Fastify({ logger: false });
  await app.register(healthRoutes);

  const start = Date.now();

  const res = await Promise.race([
    app.inject({ method: "GET", url: "/health" }),
    new Promise<never>((_resolve, reject) =>
      setTimeout(
        () => reject(new Error("TEST TIMEOUT: /health hung past 5s")),
        5_000
      )
    )
  ]);

  const elapsedMs = Date.now() - start;

  assert.ok(
    elapsedMs < 5_000,
    `expected /health to respond well under 5s, took ${elapsedMs}ms`
  );

  const body = JSON.parse(res.body);

  assert.equal(res.statusCode, 503);
  assert.equal(body.status, "degraded");
  assert.equal(body.checks.queue.status, "error");
  assert.match(body.checks.queue.error, /timed out/i);

  await app.close();
});

test("GET /readiness does not hang when the queue check never settles either", async () => {
  const app = Fastify({ logger: false });
  await app.register(healthRoutes);

  const start = Date.now();

  const res = await Promise.race([
    app.inject({ method: "GET", url: "/readiness" }),
    new Promise<never>((_resolve, reject) =>
      setTimeout(
        () => reject(new Error("TEST TIMEOUT: /readiness hung past 5s")),
        5_000
      )
    )
  ]);

  assert.ok(Date.now() - start < 5_000);

  const body = JSON.parse(res.body);

  // Readiness is gated on Postgres only (mocked healthy above) - the
  // queue check still runs and still reports its own timeout, but no
  // longer determines ready/not_ready.
  assert.equal(res.statusCode, 200);
  assert.equal(body.status, "ready");
  assert.equal(body.checks.queue.status, "error");

  await app.close();
});
