import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { acquireLock, withLock } from "./distributedLock.js";
import { closeRedis } from "./redisClient.js";
import { requireRedis } from "../testHelpers/requireInfra.js";

test.before(() => requireRedis());

test("distributedLock: a second acquire attempt fails while the first holds the lock", async () => {
  const key = `test-lock-${randomUUID()}`;

  const first = await acquireLock(key, 5000);
  assert.ok(first, "expected the first acquire to succeed");

  const second = await acquireLock(key, 5000);
  assert.equal(second, null);

  await first.release();
});

test("distributedLock: release allows a subsequent acquire", async () => {
  const key = `test-lock-${randomUUID()}`;

  const first = await acquireLock(key, 5000);
  assert.ok(first);

  await first.release();

  const second = await acquireLock(key, 5000);
  assert.ok(second, "expected acquire to succeed after release");

  await second.release();
});

test("distributedLock: releasing twice is safe and the second call reports no-op", async () => {
  const key = `test-lock-${randomUUID()}`;

  const lock = await acquireLock(key, 5000);
  assert.ok(lock);

  const firstRelease = await lock.release();
  assert.equal(firstRelease, true);

  const secondRelease = await lock.release();
  assert.equal(secondRelease, false);
});

test("distributedLock: a short TTL expires and allows another holder to acquire it", async () => {
  const key = `test-lock-${randomUUID()}`;

  const lock = await acquireLock(key, 200);
  assert.ok(lock);

  await new Promise((resolve) => setTimeout(resolve, 400));

  const next = await acquireLock(key, 5000);
  assert.ok(next, "expected the expired lock to be acquirable again");

  await next.release();
});

test("distributedLock: withLock skips the task when the lock is already held", async () => {
  const key = `test-lock-${randomUUID()}`;

  const outerLock = await acquireLock(key, 5000);
  assert.ok(outerLock);

  let ran = false;

  const result = await withLock(key, 5000, async () => {
    ran = true;
    return "should not happen";
  });

  assert.equal(result, null);
  assert.equal(ran, false);

  await outerLock.release();
});

test("distributedLock: withLock releases the lock even if the task throws", async () => {
  const key = `test-lock-${randomUUID()}`;

  await assert.rejects(
    () =>
      withLock(key, 5000, async () => {
        throw new Error("boom");
      }),
    /boom/
  );

  // Lock must be free again for a fresh acquire.
  const lock = await acquireLock(key, 5000);
  assert.ok(lock, "expected the lock to be released after the task threw");

  await lock.release();
});

test.after(async () => {
  await closeRedis();
});
