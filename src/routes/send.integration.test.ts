import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";

/*
Regression test for a real bug found via live concurrency testing
(Phase 4): POST /send had no idempotency protection at all. Three
concurrent requests with the IDENTICAL verificationId produced three
separate real sends (three distinct provider messageIds) - a single
successful verification could be replayed indefinitely to trigger
unlimited duplicate sends, since nothing tracked "has this
verificationId already been used to send."

Runs against real Postgres (to persist a verifiable record) and real
Redis (idempotency.ts's actual backing store) - this is exactly the
kind of cross-service correctness bug that only shows up against real
infrastructure.
*/

import { requirePostgres, requireRedis } from "../testHelpers/requireInfra.js";

import { VerificationRepository } from "../repositories/verificationRepository.js";

import { closeRedis } from "../redis/redisClient.js";

import sendRoutes from "./send.js";

test.before(async () => {
  await requirePostgres();
  await requireRedis();
});

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

test("POST /send: concurrent requests with the same verificationId produce exactly one real send", async () => {
  const email = "idempotency-test@example.com";
  const verificationId = await seedVerifiedRecord(email);

  const app = Fastify({ logger: false });
  await app.register(sendRoutes);

  const responses = await Promise.all([
    app.inject({
      method: "POST",
      url: "/send",
      payload: { email, verificationId, text: "attempt 1" },
    }),
    app.inject({
      method: "POST",
      url: "/send",
      payload: { email, verificationId, text: "attempt 2" },
    }),
    app.inject({
      method: "POST",
      url: "/send",
      payload: { email, verificationId, text: "attempt 3" },
    }),
  ]);

  const messageIds = responses.map((res) => {
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    assert.equal(body.outbound.success, true);
    return body.outbound.messageId;
  });

  assert.ok(messageIds[0], "expected a real messageId from the provider");

  assert.deepEqual(
    new Set(messageIds).size,
    1,
    `expected all 3 concurrent sends to share one messageId (one real send), got: ${JSON.stringify(messageIds)}`
  );

  await app.close();
});

test("POST /send: a sequential retry with the same verificationId returns the cached result, not a new send", async () => {
  const email = "idempotency-sequential-test@example.com";
  const verificationId = await seedVerifiedRecord(email);

  const app = Fastify({ logger: false });
  await app.register(sendRoutes);

  const first = await app.inject({
    method: "POST",
    url: "/send",
    payload: { email, verificationId, text: "first" },
  });

  const second = await app.inject({
    method: "POST",
    url: "/send",
    payload: { email, verificationId, text: "second, different body" },
  });

  const firstBody = JSON.parse(first.body);
  const secondBody = JSON.parse(second.body);

  assert.equal(firstBody.outbound.success, true);
  assert.equal(
    secondBody.outbound.messageId,
    firstBody.outbound.messageId,
    "a retry against the same verificationId must not trigger a second real send"
  );

  await app.close();
});

test.after(async () => {
  const { closeDatabase } = await import("../database/database.js");
  await closeDatabase();
  await closeRedis();
});
