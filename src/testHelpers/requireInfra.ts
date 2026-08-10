import { getRedis, getBullMQConnection, getBullMQWorkerConnection } from "../redis/redisClient.js";
import { getDatabase } from "../database/database.js";
import { pingStorage } from "../storage/storageProvider.js";
import { config } from "../config/config.js";

/*
==================================================
INFRASTRUCTURE PREFLIGHT CHECKS (TEST-ONLY)
==================================================

Purpose:

Integration tests need real Postgres/Redis/MinIO —
that's the point of them (see docs/OPERATIONS.md:
"do not mock Redis/PostgreSQL just to hide
infrastructure problems"). But the PRODUCTION Redis
client (src/redis/redisClient.ts) is deliberately
configured to retry forever with capped backoff —
correct for a long-running server that should
reconnect when Redis comes back, wrong for a test
run, where an unreachable dependency should fail
fast and clearly rather than hang indefinitely
(ioredis queues commands while disconnected by
default, so a bare `await redis.ping()` against a
down Redis never rejects on its own).

These helpers add a bounded timeout around the
connectivity check ONLY — they do not change
retryStrategy, offline queueing, or any other
production reconnect behavior. On failure they also
explicitly disconnect the shared client so the
background reconnect loop doesn't keep the process
alive after the test run has already failed.

Usage: call from a suite's `test.before()`, once,
before any test in that file runs.
==================================================
*/

class InfraUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InfraUnavailableError";
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
    }),
  ]);
}

export async function requireRedis(timeoutMs = 3000): Promise<void> {
  try {
    await withTimeout(getRedis().ping(), timeoutMs, "Redis ping");
  } catch (error) {
    // Stop the background reconnect loop immediately — otherwise the
    // process never exits even though the test run has already
    // failed deterministically.
    getRedis().disconnect();
    getBullMQConnection().disconnect();
    getBullMQWorkerConnection().disconnect();

    throw new InfraUnavailableError(
      `Redis is not reachable at ${config.redis.url} ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        `Integration tests require Redis — start it with: ` +
        `docker compose up -d redis`
    );
  }
}

export async function requirePostgres(timeoutMs = 5000): Promise<void> {
  try {
    await withTimeout(
      getDatabase().query("SELECT 1"),
      timeoutMs,
      "PostgreSQL query"
    );
  } catch (error) {
    throw new InfraUnavailableError(
      `PostgreSQL is not reachable via the configured DATABASE_URL ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        `Integration tests require PostgreSQL — start it with: ` +
        `docker compose up -d postgres`
    );
  }
}

export async function requireStorage(timeoutMs = 5000): Promise<void> {
  try {
    const ok = await withTimeout(pingStorage(), timeoutMs, "Storage ping");

    if (!ok) {
      throw new Error("bucket not reachable/creatable");
    }
  } catch (error) {
    throw new InfraUnavailableError(
      `Object storage is not reachable at the configured STORAGE_ENDPOINT ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        `Integration tests require it — start it with: ` +
        `docker compose up -d minio`
    );
  }
}
