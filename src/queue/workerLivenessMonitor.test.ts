import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Worker } from "bullmq";

/*
Regression test for a real bug found via a live Docker Redis-outage-
and-recovery drill: a BullMQ Worker's internal consume loop got
permanently stuck (never picking up another job) after a real
outage-and-reconnect cycle, while its own connection status and
worker.isRunning()/isPaused() all continued to report healthy - the
existing heartbeat (workerHeartbeat.ts) has no way to detect this,
since it deliberately trusts exactly the state that turned out to be
wrong. A freshly-restarted worker process, identical code, resumed
consuming immediately.

This monitor uses a stronger signal instead: is the queue's own
'active' event actually firing when there's a real backlog to
consume? These tests use a fake EventEmitter standing in for the
Worker (only .on()/.emit() are needed) and tiny interval/threshold
overrides so the whole thing runs in milliseconds instead of minutes.
*/

let waitingCount = 0;

mock.module("./verificationQueue.js", {
  namedExports: {
    getQueueCounts: async () => ({
      waiting: waitingCount,
      active: 0,
      delayed: 0,
      failed: 0,
      completed: 0,
    }),
  },
});

const { startWorkerLivenessMonitor } = await import("./workerLivenessMonitor.js");

function fakeWorker(): { worker: Worker; emitter: EventEmitter } {
  const emitter = new EventEmitter();
  return { worker: emitter as unknown as Worker, emitter };
}

test.beforeEach(() => {
  waitingCount = 0;
});

test("workerLivenessMonitor: does not flag a stall when the queue is genuinely empty", async () => {
  const { worker } = fakeWorker();
  waitingCount = 0;

  let stalledCalls = 0;

  const handle = startWorkerLivenessMonitor(worker, {
    checkIntervalMs: 10,
    stallThresholdMs: 20,
    startupGraceMs: 0,
    onStalled: () => { stalledCalls += 1; },
  });

  await new Promise((resolve) => setTimeout(resolve, 100));
  handle.stop();

  assert.equal(stalledCalls, 0, "an empty queue must never be treated as a stuck consumer");
});

test("workerLivenessMonitor: does not flag a stall while 'active' events keep firing", async () => {
  const { worker, emitter } = fakeWorker();
  waitingCount = 5;

  let stalledCalls = 0;

  const activityInterval = setInterval(() => {
    emitter.emit("active");
  }, 10);

  const handle = startWorkerLivenessMonitor(worker, {
    checkIntervalMs: 10,
    stallThresholdMs: 30,
    startupGraceMs: 0,
    onStalled: () => { stalledCalls += 1; },
  });

  await new Promise((resolve) => setTimeout(resolve, 120));
  handle.stop();
  clearInterval(activityInterval);

  assert.equal(stalledCalls, 0, "a worker that is genuinely still consuming jobs must not be flagged");
});

test("workerLivenessMonitor: flags a stall when the queue has a backlog but no job has become active for longer than the threshold", async () => {
  const { worker } = fakeWorker();
  waitingCount = 3;

  let stalledCalls = 0;

  const handle = startWorkerLivenessMonitor(worker, {
    checkIntervalMs: 10,
    stallThresholdMs: 30,
    startupGraceMs: 0,
    onStalled: () => { stalledCalls += 1; },
  });

  await new Promise((resolve) => setTimeout(resolve, 150));
  handle.stop();

  assert.ok(stalledCalls >= 1, "a non-empty queue with no active-job activity past the threshold must be flagged as stalled");
});

test("workerLivenessMonitor: respects the startup grace period - does not flag during it even with a backlog", async () => {
  const { worker } = fakeWorker();
  waitingCount = 3;

  let stalledCalls = 0;

  const handle = startWorkerLivenessMonitor(worker, {
    checkIntervalMs: 10,
    stallThresholdMs: 5,
    startupGraceMs: 100,
    onStalled: () => { stalledCalls += 1; },
  });

  await new Promise((resolve) => setTimeout(resolve, 60));
  handle.stop();

  assert.equal(stalledCalls, 0, "must not flag anything before the startup grace period elapses");
});

test("workerLivenessMonitor: stop() halts further checks", async () => {
  const { worker } = fakeWorker();
  waitingCount = 3;

  let stalledCalls = 0;

  const handle = startWorkerLivenessMonitor(worker, {
    checkIntervalMs: 10,
    stallThresholdMs: 15,
    startupGraceMs: 0,
    onStalled: () => { stalledCalls += 1; },
  });

  handle.stop();

  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(stalledCalls, 0, "no checks should run after stop()");
});
