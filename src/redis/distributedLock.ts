import { randomUUID } from "node:crypto";

import { getRedis } from "./redisClient.js";

/*
==================================================
DISTRIBUTED LOCK
==================================================

Purpose:

A simple, single-node Redis lock (SET NX PX +
token-checked release) for coordinating exclusive
work across multiple horizontally-scaled process
instances — e.g. "only one instance should run this
scheduled maintenance task right now."

This is intentionally NOT a Redlock-style multi-node
quorum implementation: this service runs against a
single logical Redis (as configured), so the added
complexity of multi-node consensus isn't justified.
If Redis is ever deployed as an independently-failing
multi-primary cluster, revisit this.

Every lock has a mandatory expiration — there is no
API for an unbounded lock, so a crashed holder can
never wedge the resource forever.

Not currently used by any route/service in this
codebase (verified via a repo-wide grep during a
2026-08 production-hardening audit) - only its own
integration test exercises it. Uses the main, patient
getRedis() connection, which is correct for this
module's OWN documented use case (infrequent
maintenance-task coordination, not a hot request
path) - but if a future caller ever awaits acquire()
synchronously inside an HTTP request path, revisit
that choice the same way idempotency.ts's own
dedicated fail-fast connection was added: a patient
multi-second wait for a lock is exactly the kind of
unbounded-hang risk this project has repeatedly found
and fixed elsewhere (POST /verify/batch/async, POST
/send).
==================================================
*/

const UNLOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

const EXTEND_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
else
  return 0
end
`;

export interface DistributedLockHandle {
  readonly key: string;
  readonly token: string;
  release(): Promise<boolean>;
  extend(ttlMs: number): Promise<boolean>;
}

/**
 * Attempts to acquire a lock. Returns null immediately if the lock
 * is already held (never blocks/queues — callers decide whether to
 * retry, skip, or fail).
 */
export async function acquireLock(
  key: string,
  ttlMs: number
): Promise<DistributedLockHandle | null> {

  const token = randomUUID();
  const lockKey = `lock:${key}`;

  const result = await getRedis().set(
    lockKey,
    token,
    "PX",
    ttlMs,
    "NX"
  );

  if (result !== "OK") {
    return null;
  }

  return {
    key: lockKey,
    token,

    async release(): Promise<boolean> {
      const removed = await getRedis().eval(
        UNLOCK_SCRIPT,
        1,
        lockKey,
        token
      );
      return removed === 1;
    },

    async extend(extendTtlMs: number): Promise<boolean> {
      const extended = await getRedis().eval(
        EXTEND_SCRIPT,
        1,
        lockKey,
        token,
        extendTtlMs
      );
      return extended === 1;
    },
  };

}

/**
 * Runs `task` only if the lock can be acquired; otherwise resolves
 * to null without running it. Always releases the lock afterward,
 * even if `task` throws.
 */
export async function withLock<T>(
  key: string,
  ttlMs: number,
  task: () => Promise<T>
): Promise<T | null> {

  const lock = await acquireLock(key, ttlMs);

  if (!lock) {
    return null;
  }

  try {
    return await task();
  } finally {
    await lock.release();
  }

}
