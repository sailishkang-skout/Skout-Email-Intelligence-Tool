import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/*
Regression test for a real Docker healthcheck bug: the worker
container's HEALTHCHECK (inherited from the shared Dockerfile image)
probed the API's HTTP /liveness endpoint, which can never succeed in
the worker process since it runs no HTTP server at all - not a bug in
the worker itself (confirmed live: process alive, real successful
Redis/BullMQ TCP connections, clean startup logs), just a healthcheck
checking for something that structurally cannot exist there.

Fixed with a file-based readiness heartbeat that only gets refreshed
while the worker is genuinely healthy - this test verifies that
condition directly: the heartbeat file must only be written when the
BullMQ Worker instance is running, unpaused, AND its Redis connection
status is "ready" - not just because a process happens to be alive.
*/

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-heartbeat-test-"));
process.env.WORKER_HEARTBEAT_DIR = tmpDir;

const { startWorkerHeartbeat } = await import("./workerHeartbeat.js");

const heartbeatFile = path.join(tmpDir, "ready");

function fakeWorker(overrides: { isRunning?: boolean; isPaused?: boolean } = {}) {
  return {
    isRunning: () => overrides.isRunning ?? true,
    isPaused: () => overrides.isPaused ?? false,
  } as unknown as import("bullmq").Worker;
}

function fakeRedis(status: string) {
  return { status } as unknown as import("ioredis").Redis;
}

test("workerHeartbeat: writes the heartbeat file when the worker is running, unpaused, and Redis is ready", () => {
  const stop = startWorkerHeartbeat(fakeWorker(), fakeRedis("ready"));

  try {
    assert.ok(fs.existsSync(heartbeatFile), "expected the heartbeat file to be written immediately");
    const contents = fs.readFileSync(heartbeatFile, "utf-8");
    assert.ok(Number(contents) > 0, "expected the heartbeat file to contain a timestamp");
  } finally {
    stop();
  }
});

test("workerHeartbeat: does NOT write when the worker is not running", () => {
  fs.rmSync(heartbeatFile, { force: true });

  const stop = startWorkerHeartbeat(fakeWorker({ isRunning: false }), fakeRedis("ready"));

  try {
    assert.equal(
      fs.existsSync(heartbeatFile),
      false,
      "a stopped worker must never be reported as ready via the heartbeat"
    );
  } finally {
    stop();
  }
});

test("workerHeartbeat: does NOT write when the worker is paused", () => {
  fs.rmSync(heartbeatFile, { force: true });

  const stop = startWorkerHeartbeat(fakeWorker({ isPaused: true }), fakeRedis("ready"));

  try {
    assert.equal(fs.existsSync(heartbeatFile), false);
  } finally {
    stop();
  }
});

test("workerHeartbeat: does NOT write when the Redis connection is not ready", () => {
  fs.rmSync(heartbeatFile, { force: true });

  const stop = startWorkerHeartbeat(fakeWorker(), fakeRedis("reconnecting"));

  try {
    assert.equal(
      fs.existsSync(heartbeatFile),
      false,
      "a worker that lost its Redis connection must go stale, not stay falsely 'ready'"
    );
  } finally {
    stop();
  }
});

test("workerHeartbeat: stop() halts further updates", async () => {
  fs.rmSync(heartbeatFile, { force: true });

  const stop = startWorkerHeartbeat(fakeWorker(), fakeRedis("ready"));
  assert.ok(fs.existsSync(heartbeatFile));

  const firstWrite = fs.statSync(heartbeatFile).mtimeMs;
  stop();

  await new Promise((resolve) => setTimeout(resolve, 50));

  const afterStop = fs.statSync(heartbeatFile).mtimeMs;
  assert.equal(afterStop, firstWrite, "no further writes should happen after stop()");
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
