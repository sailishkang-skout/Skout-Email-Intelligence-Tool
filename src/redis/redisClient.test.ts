import { test } from "node:test";
import assert from "node:assert/strict";

import { getRedis, getRateLimitRedisConnection, getBullMQConnection, getBullMQWorkerConnection } from "./redisClient.js";

/*
Regression test for a real bug found via a live Redis-outage drill:
@fastify/rate-limit was sharing the main Redis client's patient
connectTimeout (10s, correct for business-critical usage like BullMQ
job processing). Since skipOnError only decides what happens AFTER
the rate-limit store's Redis command fails - not how long that
failure takes - EVERY request, including ones touching no other
infrastructure at all, took 10+ extra seconds during a Redis outage
before the rate-limit check gave up and let it through. Confirmed
live: a plain validation-only /verify call went from ~1.8s to 13.1s
during an outage.

This guards the fix at the configuration level: the rate-limit
connection must stay a genuinely separate instance from the main
client, with short, fail-fast settings, so nobody accidentally
reverts to sharing the main (patient) connection in the future.
*/

test("redisClient: the rate-limit connection is a separate instance from the main client", () => {
  assert.notEqual(
    getRateLimitRedisConnection(),
    getRedis(),
    "rate limiting must not share the main client's patient connectTimeout"
  );
});

test("redisClient: the rate-limit connection is configured to fail fast, not to match the main client's patient settings", () => {
  const rateLimitConn = getRateLimitRedisConnection();
  const mainConn = getRedis();

  const rateLimitTimeout = rateLimitConn.options.connectTimeout;
  const mainTimeout = mainConn.options.connectTimeout;

  assert.ok(
    typeof rateLimitTimeout === "number" &&
    typeof mainTimeout === "number" &&
    rateLimitTimeout < mainTimeout,
    `rate-limit connectTimeout (${rateLimitTimeout}ms) must be shorter than the main client's (${mainTimeout}ms) - it exists specifically to fail fast`
  );

  assert.equal(
    rateLimitConn.options.maxRetriesPerRequest,
    1,
    "rate limiting is best-effort/fail-open (skipOnError: true) - it should give up after one attempt, not retry like business-critical Redis usage"
  );
});

/*
Regression test for a real bug found via a live Redis-outage-and-
recovery drill against Docker: the worker process runs BOTH a BullMQ
Worker (real job consumption) and the outbox dispatcher's Queue.add()
calls in the same process. When both shared getBullMQConnection(),
the Worker's internal blocking-read loop got permanently stuck (no
longer consuming any jobs) after a real Redis outage-and-reconnect
cycle - while the connection's own `.status` still correctly reported
"ready", so the file-based heartbeat (and Docker's healthcheck built
on it) kept reporting the container healthy the entire time. A
freshly-restarted worker process, identical code, picked the stalled
job back up immediately, confirming the stuck state belonged to that
shared connection/Worker combination, not a deeper logic bug.

This guards the fix at the configuration level: the Worker's
connection must stay genuinely separate from the Queue/dispatcher's,
so nobody accidentally reverts to sharing one connection between a
blocking consumer loop and a producer in the future.
*/

test("redisClient: the BullMQ Worker connection is a separate instance from the Queue/dispatcher connection", () => {
  assert.notEqual(
    getBullMQWorkerConnection(),
    getBullMQConnection(),
    "the Worker's blocking consume loop must not share a connection with Queue.add() producer calls in the same process"
  );
});

test.after(async () => {
  const { closeRedis } = await import("./redisClient.js");
  await closeRedis();
});
