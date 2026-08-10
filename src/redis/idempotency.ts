import { getIdempotencyRedisConnection } from "./redisClient.js";
import { extractErrorMessage } from "../utils/errorMessage.js";

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

Fail-fast, fail-CLOSED:

The connection this module uses (see
getIdempotencyRedisConnection in redisClient.ts) is
deliberately configured to fail fast during a Redis
outage rather than hang or silently queue the
command for later. When it fails, claimIdempotencyKey
throws IdempotencyUnavailableError instead of letting
a raw ioredis error propagate - the caller (e.g.
POST /send) can then give the caller a specific,
truthful reason ("the safety check itself could not
be performed") rather than a generic failure, AND
critically must treat that as "do not proceed" - if
idempotency can't be established, the side effect
(sending a real email) must not run. That fail-closed
behavior falls directly out of runIdempotent()'s
control flow below: it awaits the claim BEFORE ever
calling `operation`, so a thrown claim error - for any
reason - guarantees the operation never runs.
==================================================
*/

const KEY_PREFIX = "idempotency:";

export type IdempotencyClaimResult<T> =
  | { status: "claimed" }
  | { status: "duplicate"; cached: T }
  | { status: "in_progress" };

/**
 * Thrown when the idempotency store itself (Redis) could not be
 * reached to establish a claim - as distinct from a normal "already
 * claimed"/"in progress" outcome. Callers must treat this the same
 * as "idempotency cannot be guaranteed right now" and refuse to
 * proceed with the side-effecting operation, not just log and
 * continue.
 */
export class IdempotencyUnavailableError extends Error {
  constructor(key: string, cause: unknown) {
    super(`Could not establish an idempotency claim for key "${key}": ${extractErrorMessage(cause)}`);
    this.name = "IdempotencyUnavailableError";
  }
}

/**
 * Attempts to claim an idempotency key. Callers that get
 * `{ status: "claimed" }` must eventually call `completeIdempotentOperation`
 * (success or failure) so the key doesn't stay stuck as in-progress
 * beyond `inProgressTtlMs`.
 *
 * Throws IdempotencyUnavailableError (rather than a raw Redis error)
 * if the store itself is unreachable - see the module doc comment
 * above for why that must fail the caller closed, not open.
 */
export async function claimIdempotencyKey<T>(
  key: string,
  inProgressTtlMs = 30_000
): Promise<IdempotencyClaimResult<T>> {

  const redisKey = `${KEY_PREFIX}${key}`;

  let claimed: string | null;

  try {

    claimed = await getIdempotencyRedisConnection().set(
      redisKey,
      JSON.stringify({ status: "in_progress" }),
      "PX",
      inProgressTtlMs,
      "NX"
    );

  } catch (error) {

    throw new IdempotencyUnavailableError(key, error);

  }

  if (claimed === "OK") {
    return { status: "claimed" };
  }

  const existing = await getIdempotencyRedisConnection().get(redisKey).catch((error: unknown) => {
    throw new IdempotencyUnavailableError(key, error);
  });

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

  await getIdempotencyRedisConnection().set(
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

  await getIdempotencyRedisConnection().del(`${KEY_PREFIX}${key}`);

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

  let result: T;

  try {

    result = await operation();

  } catch (error) {

    // The operation itself failed - release the claim so a retry can
    // attempt it again. A failure to release here just means the key
    // stays claimed until inProgressTtlMs expires - a retry within
    // that window is safely rejected (409) rather than duplicated,
    // so it's logged, not re-thrown over the operation's own error.
    await releaseIdempotencyKey(key).catch((releaseError: unknown) => {
      console.error(
        `[Idempotency] Failed to release key "${key}" after a failed operation:`,
        extractErrorMessage(releaseError)
      );
    });

    throw error;

  }

  /*
  The operation already succeeded (a real send, in POST /send's case,
  has already happened) - from here on, a failure to CACHE that
  result must never be reported to the caller as if the operation
  itself failed. Doing so would be exactly backwards: it would tell a
  caller "your send failed" when it actually succeeded, which is just
  as untruthful as the outage-hang bug this project exists to fix,
  in the opposite direction. The in-progress marker's own TTL still
  protects against an immediate duplicate in the meantime.
  */
  try {

    await completeIdempotentOperation(
      key,
      result,
      options.resultTtlMs
    );

  } catch (error) {

    console.error(
      `[Idempotency] Operation for key "${key}" succeeded but caching its result failed - a retry within the in-progress TTL will still be safely rejected rather than duplicated:`,
      extractErrorMessage(error)
    );

  }

  return result;

}
