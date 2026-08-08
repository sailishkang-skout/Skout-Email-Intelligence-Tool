import { getRedis } from "./redisClient.js";

/*
==================================================
IDEMPOTENCY
==================================================

Purpose:

Ensures a side-effecting operation (an API mutation,
an outbound send, a job handler) executes at most
once for a given idempotency key, even if the caller
retries or a job is redelivered.

Strategy:

1. Try to claim the key with SET NX (a short-lived
   "in progress" marker).
2. If the claim succeeds, the caller proceeds and
   must call complete() with the result, which is
   cached under the same key for the full TTL.
3. If the key is already claimed, either the result
   is already cached (return it) or the original
   attempt is still in flight (report as such — the
   caller should not duplicate the side effect).

Redis holds the idempotency record, not the business
outcome itself: business state changes still belong
to PostgreSQL. This module only prevents the
operation that WRITES that state from running twice.
==================================================
*/

const KEY_PREFIX = "idempotency:";

export type IdempotencyClaimResult<T> =
  | { status: "claimed" }
  | { status: "duplicate"; cached: T }
  | { status: "in_progress" };

/**
 * Attempts to claim an idempotency key. Callers that get
 * `{ status: "claimed" }` must eventually call `completeIdempotentOperation`
 * (success or failure) so the key doesn't stay stuck as in-progress
 * beyond `inProgressTtlMs`.
 */
export async function claimIdempotencyKey<T>(
  key: string,
  inProgressTtlMs = 30_000
): Promise<IdempotencyClaimResult<T>> {

  const redisKey = `${KEY_PREFIX}${key}`;

  const claimed = await getRedis().set(
    redisKey,
    JSON.stringify({ status: "in_progress" }),
    "PX",
    inProgressTtlMs,
    "NX"
  );

  if (claimed === "OK") {
    return { status: "claimed" };
  }

  const existing = await getRedis().get(redisKey);

  if (!existing) {
    // Raced with expiry between the failed NX and this GET; treat
    // as claimable by the caller's retry rather than blocking
    // forever.
    return { status: "claimed" };
  }

  try {

    const parsed = JSON.parse(existing) as
      | { status: "in_progress" }
      | { status: "completed"; result: T };

    if (parsed.status === "completed") {
      return { status: "duplicate", cached: parsed.result };
    }

    return { status: "in_progress" };

  } catch {

    return { status: "in_progress" };

  }

}

/**
 * Records the result of a claimed operation so subsequent duplicate
 * attempts return the cached result instead of re-running it.
 */
export async function completeIdempotentOperation<T>(
  key: string,
  result: T,
  resultTtlMs = 24 * 60 * 60 * 1000 // 24h
): Promise<void> {

  const redisKey = `${KEY_PREFIX}${key}`;

  await getRedis().set(
    redisKey,
    JSON.stringify({ status: "completed", result }),
    "PX",
    resultTtlMs
  );

}

/**
 * Releases a claimed key without caching a result — use when the
 * operation failed in a way that SHOULD be retried (as opposed to
 * a definitive failure result worth caching).
 */
export async function releaseIdempotencyKey(
  key: string
): Promise<void> {

  await getRedis().del(`${KEY_PREFIX}${key}`);

}

/**
 * Convenience wrapper: runs `operation` at most once per key. If a
 * cached result exists, returns it without re-running. If another
 * in-flight attempt holds the key, throws — the caller (typically an
 * HTTP handler) should surface this as a 409/425-style response
 * rather than silently retrying.
 */
export class IdempotencyInProgressError extends Error {
  constructor(key: string) {
    super(`Operation for idempotency key "${key}" is already in progress`);
    this.name = "IdempotencyInProgressError";
  }
}

export async function runIdempotent<T>(
  key: string,
  operation: () => Promise<T>,
  options: { inProgressTtlMs?: number; resultTtlMs?: number } = {}
): Promise<T> {

  const claim = await claimIdempotencyKey<T>(
    key,
    options.inProgressTtlMs
  );

  if (claim.status === "duplicate") {
    return claim.cached;
  }

  if (claim.status === "in_progress") {
    throw new IdempotencyInProgressError(key);
  }

  try {

    const result = await operation();

    await completeIdempotentOperation(
      key,
      result,
      options.resultTtlMs
    );

    return result;

  } catch (error) {

    await releaseIdempotencyKey(key);
    throw error;

  }

}
