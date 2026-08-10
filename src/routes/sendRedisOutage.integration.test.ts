import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";

/*
Real regression test for the exact class of bug this whole project
targets (POST /verify/batch/async hanging/lying during a Redis
outage), now checked against POST /send: a Redis outage must produce
a bounded, truthful response - never an unbounded hang - and
critically must NEVER allow the real send to happen when idempotency
can't be established (see idempotency.ts's fail-closed design and
redisClient.ts's getIdempotencyRedisConnection()).

Simulates the outage via a fake Redis client substituted for the
dedicated fail-fast idempotency connection only (stopping a real
Redis mid-test isn't practical for an automated suite - see the final
report for the actual Docker `docker compose stop redis` drill that
validates this same behavior against real infrastructure). Everything
else - Postgres, real send.ts/idempotency.ts control flow - is real.
The outbound provider is mocked only so send attempts can be counted
directly, proving zero sends rather than merely inferring it from the
HTTP response.
*/

let redisAvailable = false;

const fakeRedisConnection = {
  set: async () => {
    if (!redisAvailable) {
      throw new Error("connect ETIMEDOUT (simulated Redis outage)");
    }
    return "OK";
  },
  get: async () => {
    if (!redisAvailable) {
      throw new Error("connect ETIMEDOUT (simulated Redis outage)");
    }
    return null;
  },
  del: async () => {
    if (!redisAvailable) {
      throw new Error("connect ETIMEDOUT (simulated Redis outage)");
    }
    return 1;
  },
};

mock.module("../redis/redisClient.js", {
  namedExports: {
    getIdempotencyRedisConnection: () => fakeRedisConnection,
  },
});

let sendCallCount = 0;

mock.module("../services/mockEmailSendProvider.js", {
  namedExports: {
    MockEmailSendProvider: class {
      async send() {
        sendCallCount += 1;
        return {
          provider: "mock",
          messageId: `mock-${randomUUID()}`,
          accepted: true,
          response: "250 2.0.0 OK",
        };
      }
    },
  },
});

import { requirePostgres } from "../testHelpers/requireInfra.js";

test.before(() => requirePostgres());

const { default: sendRoutes } = await import("./send.js");
const { VerificationRepository } = await import("../repositories/verificationRepository.js");

async function seedVerifiedRecord(email: string): Promise<string> {
  const verificationId = randomUUID();
  const repository = new VerificationRepository();

  await repository.save({
    verificationId,
    email,
    domain: email.split("@")[1] ?? "",
    responseCode: 250,
    responseMessage: "250 OK",
    smtpValid: true,
    mailboxExists: true,
    mxAvailable: true,
    catchAll: false,
    retryRequired: false,
    confidenceScore: 100,
    confidenceLevel: "VERY_HIGH",
    decision: "SAFE_TO_SEND",
    recommendation: "SAFE_TO_SEND",
    verificationStatus: "VERIFIED",
  });

  return verificationId;
}

test.beforeEach(() => {
  sendCallCount = 0;
});

test("POST /send: a Redis outage produces a bounded, truthful 503 and does NOT send an email", async () => {
  redisAvailable = false;

  const email = `redis-outage-send-test-${randomUUID()}@example.com`;
  const verificationId = await seedVerifiedRecord(email);

  const app = Fastify({ logger: false });
  await app.register(sendRoutes);

  const start = Date.now();

  const res = await app.inject({
    method: "POST",
    url: "/send",
    payload: { email, verificationId, text: "should not send" },
  });

  const elapsedMs = Date.now() - start;

  assert.ok(elapsedMs < 5_000, `expected a fast, bounded response (no hang), took ${elapsedMs}ms`);
  assert.equal(res.statusCode, 503);

  const body = JSON.parse(res.body);
  assert.equal(body.success, false);
  assert.match(body.error, /safety check temporarily unavailable/);

  assert.equal(sendCallCount, 0, "the provider must never be called when idempotency cannot be established");

  await app.close();
});

test("POST /send: Redis recovering afterward does not trigger a delayed hidden send for the earlier failed request", async () => {
  redisAvailable = false;

  const email = `redis-recovery-send-test-${randomUUID()}@example.com`;
  const verificationId = await seedVerifiedRecord(email);

  const app = Fastify({ logger: false });
  await app.register(sendRoutes);

  const res = await app.inject({
    method: "POST",
    url: "/send",
    payload: { email, verificationId, text: "should not send" },
  });

  assert.equal(res.statusCode, 503);
  assert.equal(sendCallCount, 0);

  // "Redis recovers." Nothing about the ALREADY-COMPLETED request
  // above can retroactively trigger a send: runIdempotent() never
  // called the operation in the first place (the claim itself threw
  // before sendOutboundEmail() was ever reached), so there is no
  // queued/offline-buffered side effect left waiting to fire.
  redisAvailable = true;

  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(
    sendCallCount,
    0,
    "recovery must not cause the earlier, already-failed request to send after the fact"
  );

  // A genuinely NEW request now succeeds normally - proves recovery
  // itself works and this isn't just permanently broken.
  const secondEmail = `redis-recovery-send-test-2-${randomUUID()}@example.com`;
  const secondVerificationId = await seedVerifiedRecord(secondEmail);

  const recoveredRes = await app.inject({
    method: "POST",
    url: "/send",
    payload: { email: secondEmail, verificationId: secondVerificationId, text: "should send now" },
  });

  assert.equal(recoveredRes.statusCode, 200);

  const recoveredBody = JSON.parse(recoveredRes.body);
  assert.equal(recoveredBody.outbound.success, true);
  assert.equal(sendCallCount, 1);

  await app.close();
});

test.after(async () => {
  const { closeDatabase } = await import("../database/database.js");
  await closeDatabase();
});
