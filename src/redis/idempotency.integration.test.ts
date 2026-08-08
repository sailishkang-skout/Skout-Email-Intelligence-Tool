import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  runIdempotent,
  IdempotencyInProgressError,
  claimIdempotencyKey,
} from "./idempotency.js";

import { closeRedis } from "./redisClient.js";
import { requireRedis } from "../testHelpers/requireInfra.js";

test.before(() => requireRedis());

test("idempotency: runIdempotent executes the operation exactly once for a given key", async () => {
  const key = `test-idempotency-${randomUUID()}`;

  let callCount = 0;

  const operation = async () => {
    callCount += 1;
    return { value: 42 };
  };

  const first = await runIdempotent(key, operation);
  const second = await runIdempotent(key, operation);

  assert.deepEqual(first, { value: 42 });
  assert.deepEqual(second, { value: 42 });
  assert.equal(
    callCount,
    1,
    "the underlying operation must not run twice for the same key"
  );
});

test("idempotency: a second concurrent attempt while the first is in-flight throws", async () => {
  const key = `test-idempotency-${randomUUID()}`;

  const claim = await claimIdempotencyKey(key);
  assert.equal(claim.status, "claimed");

  // Simulate a second caller racing in before the first completes.
  await assert.rejects(
    () => runIdempotent(key, async () => "should not run"),
    IdempotencyInProgressError
  );
});

test("idempotency: a failed operation releases the key so a retry can run it again", async () => {
  const key = `test-idempotency-${randomUUID()}`;

  let attempts = 0;

  await assert.rejects(
    () =>
      runIdempotent(key, async () => {
        attempts += 1;
        throw new Error("transient failure");
      }),
    /transient failure/
  );

  const result = await runIdempotent(key, async () => {
    attempts += 1;
    return "succeeded on retry";
  });

  assert.equal(result, "succeeded on retry");
  assert.equal(attempts, 2);
});

test.after(async () => {
  await closeRedis();
});
