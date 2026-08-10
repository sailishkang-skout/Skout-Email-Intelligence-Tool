import { test, mock } from "node:test";
import assert from "node:assert/strict";

/*
Unit-level coverage for the outbox dispatcher's control flow
(claim/dispatch/mark/commit orchestration, backoff, and deterministic
shutdown) using fake in-memory outbox rows instead of real
Postgres/Redis - see outboxDispatcher.integration.test.ts for the
real-infrastructure version of these same guarantees.
*/

interface FakeOutboxRow {
  id: string;
  jobId: string;
  itemId: string;
  email: string;
  attempts: number;
  status: "PENDING" | "DISPATCHED" | "FAILED";
  lastError: string | null;
}

let rows: FakeOutboxRow[] = [];
let commitCalls = 0;
let rollbackCalls = 0;
let enqueueBehavior: (email: string) => Promise<void> = async () => {};
let enqueueCalls: string[] = [];

const FAKE_CLIENT = { fake: true } as unknown as import("pg").PoolClient;

mock.module("../services/verificationJobService.js", {
  namedExports: {
    claimPendingOutboxRows: async (limit: number) => {
      const claimable = rows.filter((row) => row.status === "PENDING").slice(0, limit);
      return { client: FAKE_CLIENT, rows: claimable.map(({ id, jobId, itemId, email, attempts }) => ({ id, jobId, itemId, email, attempts })) };
    },
    markOutboxDispatched: async (_client: unknown, outboxId: string) => {
      const row = rows.find((r) => r.id === outboxId);
      if (row) {
        row.status = "DISPATCHED";
        row.lastError = null;
      }
    },
    markOutboxFailed: async (
      _client: unknown,
      outboxId: string,
      error: unknown,
      attemptsMade: number,
      _backoffMs: number
    ) => {
      const row = rows.find((r) => r.id === outboxId);
      if (row) {
        row.attempts = attemptsMade;
        row.lastError = error instanceof Error ? error.message : String(error);
      }
    },
    commitOutboxClaim: async () => {
      commitCalls += 1;
    },
    rollbackOutboxClaim: async () => {
      rollbackCalls += 1;
    },
  },
});

mock.module("./verificationQueue.js", {
  namedExports: {
    enqueueVerificationItem: async (payload: { email: string }) => {
      enqueueCalls.push(payload.email);
      await enqueueBehavior(payload.email);
    },
  },
});

const { dispatchPendingOutboxBatch, startOutboxDispatcher } = await import("./outboxDispatcher.js");

test.beforeEach(() => {
  rows = [];
  commitCalls = 0;
  rollbackCalls = 0;
  enqueueCalls = [];
  enqueueBehavior = async () => {};
});

test("outboxDispatcher: dispatches a pending row and marks it DISPATCHED", async () => {
  rows.push({
    id: "outbox-1",
    jobId: "job-1",
    itemId: "item-1",
    email: "a@example.com",
    attempts: 0,
    status: "PENDING",
    lastError: null,
  });

  const result = await dispatchPendingOutboxBatch();

  assert.equal(result.dispatched, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(enqueueCalls, ["a@example.com"]);
  assert.equal(rows[0].status, "DISPATCHED");
  assert.equal(commitCalls, 1);
  assert.equal(rollbackCalls, 0);
});

test("outboxDispatcher: records a failed enqueue attempt with an incremented attempt count, keeps polling", async () => {
  rows.push({
    id: "outbox-2",
    jobId: "job-2",
    itemId: "item-2",
    email: "b@example.com",
    attempts: 2,
    status: "PENDING",
    lastError: null,
  });

  enqueueBehavior = async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:6379");
  };

  const result = await dispatchPendingOutboxBatch();

  assert.equal(result.dispatched, 0);
  assert.equal(result.failed, 1);
  assert.equal(rows[0].attempts, 3, "attempts should be incremented by one");
  assert.equal(rows[0].lastError, "connect ECONNREFUSED 127.0.0.1:6379");
  assert.equal(commitCalls, 1, "the batch must still commit - a failed row is a valid, recorded outcome, not a reason to roll back the whole batch");
});

test("outboxDispatcher: a Redis outage on one row does not prevent other rows in the same batch from dispatching", async () => {
  rows.push(
    { id: "outbox-3", jobId: "job-3", itemId: "item-3", email: "fails@example.com", attempts: 0, status: "PENDING", lastError: null },
    { id: "outbox-4", jobId: "job-4", itemId: "item-4", email: "succeeds@example.com", attempts: 0, status: "PENDING", lastError: null }
  );

  enqueueBehavior = async (email) => {
    if (email === "fails@example.com") {
      throw new Error("getaddrinfo ENOTFOUND redis");
    }
  };

  const result = await dispatchPendingOutboxBatch();

  assert.equal(result.dispatched, 1);
  assert.equal(result.failed, 1);
  assert.equal(rows.find((r) => r.id === "outbox-3")?.status, "PENDING");
  assert.equal(rows.find((r) => r.id === "outbox-4")?.status, "DISPATCHED");
});

test("outboxDispatcher: an empty claim still commits (releases the transaction) without dispatching anything", async () => {
  const result = await dispatchPendingOutboxBatch();

  assert.equal(result.dispatched, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.hadFullBatch, false);
  assert.equal(commitCalls, 1);
  assert.equal(enqueueCalls.length, 0);
});

test("outboxDispatcher: a Redis outage does not crash the dispatcher loop - it keeps running and stop() is still deterministic", async () => {
  rows.push({
    id: "outbox-5",
    jobId: "job-5",
    itemId: "item-5",
    email: "outage@example.com",
    attempts: 0,
    status: "PENDING",
    lastError: null,
  });

  enqueueBehavior = async () => {
    throw new Error("Redis connection error");
  };

  const handle = startOutboxDispatcher();

  // Give the loop a moment to run at least one tick.
  await new Promise((resolve) => setTimeout(resolve, 50));

  await assert.doesNotReject(handle.stop());

  assert.ok(rows[0].attempts >= 1, "the dispatcher should have attempted at least once despite the failure");
});

test("outboxDispatcher: stop() waits for an in-flight batch to finish before resolving", async () => {
  let releaseEnqueue: (() => void) | null = null;

  rows.push({
    id: "outbox-6",
    jobId: "job-6",
    itemId: "item-6",
    email: "slow@example.com",
    attempts: 0,
    status: "PENDING",
    lastError: null,
  });

  enqueueBehavior = () =>
    new Promise((resolve) => {
      releaseEnqueue = resolve;
    });

  const handle = startOutboxDispatcher();

  // Wait until the in-flight enqueue call has actually started.
  while (enqueueCalls.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const stopPromise = handle.stop();

  let stopResolved = false;
  void stopPromise.then(() => {
    stopResolved = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stopResolved, false, "stop() must not resolve while a batch is still mid-dispatch");

  releaseEnqueue!();
  await stopPromise;

  assert.equal(stopResolved, true);
  assert.equal(rows[0].status, "DISPATCHED", "the in-flight row should have finished dispatching before stop() resolved");
});
