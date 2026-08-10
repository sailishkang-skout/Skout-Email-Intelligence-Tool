import { Redis } from "ioredis";

import { config } from "../config/config.js";
import { extractErrorMessage } from "../utils/errorMessage.js";

/*
==================================================
REDIS CONNECTION
==================================================

Purpose:

Shared distributed infrastructure layer: caching,
distributed rate limiting, distributed locks,
idempotency keys, and the BullMQ queue backend.

Redis must never become the authoritative store for
business data — that's PostgreSQL's job. Everything
here is either ephemeral or safely reconstructable.
==================================================
*/

let client: Redis | null = null;

function createClient(): Redis {

  const instance = new Redis(config.redis.url, {
    connectTimeout: config.redis.connectTimeoutMs,
    maxRetriesPerRequest: config.redis.maxRetriesPerRequest,
    // Exponential backoff capped at 5s, so a transient outage
    // doesn't produce a reconnect storm.
    retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
    lazyConnect: false,
  });

  instance.on("error", (error) => {
    console.error("[Redis] Connection error:", extractErrorMessage(error));
  });

  instance.on("reconnecting", (delay: number) => {
    console.warn(`[Redis] Reconnecting in ${delay}ms`);
  });

  return instance;

}

export function getRedis(): Redis {

  if (!client) {
    client = createClient();
  }

  return client;

}

/*
==================================================
BULLMQ CONNECTION
==================================================

BullMQ requires maxRetriesPerRequest: null on its
Redis connection (it manages retries itself via
blocking commands). Using the same connection
options as the general client but with that one
override, and as a SEPARATE connection instance —
BullMQ's blocking commands (BRPOPLPUSH etc.) would
otherwise stall other Redis usage sharing the same
connection. Used by the Queue/QueueEvents side (see
verificationQueue.ts) - producers, not the blocking
consumer loop. See getBullMQWorkerConnection() below
for why the Worker needs its OWN separate connection,
not this one.
==================================================
*/

let bullConnection: Redis | null = null;

export function getBullMQConnection(): Redis {

  if (!bullConnection) {

    bullConnection = new Redis(config.redis.url, {
      connectTimeout: config.redis.connectTimeoutMs,
      maxRetriesPerRequest: null,
      retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
    });

    bullConnection.on("error", (error) => {
      console.error("[Redis:BullMQ] Connection error:", extractErrorMessage(error));
    });

  }

  return bullConnection;

}

/*
==================================================
BULLMQ WORKER CONNECTION
==================================================

Confirmed live during a production-hardening pass: the
worker process runs BOTH a BullMQ Worker (real job
consumption, verificationQueueWorker.ts) AND the outbox
dispatcher's Queue.add() calls (verificationQueue.ts,
via enqueueVerificationItem) in the SAME process. Before
this, both shared getBullMQConnection() above. After a
real Redis outage-and-recovery cycle, the Worker's
internal blocking-read loop got permanently stuck - not
consuming any further jobs - while the shared
connection's `.status` still correctly reported "ready"
(so the file-based heartbeat, and Docker's healthcheck
built on it, kept reporting the container healthy the
entire time). A freshly-restarted worker process, same
code, immediately picked the stalled job back up,
confirming the stuck state belonged to that one
connection/Worker instance, not a deeper logic bug.

This mirrors exactly why getBullMQConnection() above
was already split off from the general getRedis()
client (blocking commands must not share a connection
with other usage) - it just didn't go far enough: a
Worker's blocking consume loop and a Queue's regular
producer commands are two different usage patterns that
apparently should not share a connection with EACH
OTHER either, especially across a reconnect. A dedicated
connection for the Worker removes that interaction
entirely rather than chasing the exact ioredis/BullMQ
reconnect interleaving that caused it.
==================================================
*/

let bullWorkerConnection: Redis | null = null;

export function getBullMQWorkerConnection(): Redis {

  if (!bullWorkerConnection) {

    bullWorkerConnection = new Redis(config.redis.url, {
      connectTimeout: config.redis.connectTimeoutMs,
      maxRetriesPerRequest: null,
      retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
    });

    bullWorkerConnection.on("error", (error) => {
      console.error("[Redis:BullMQWorker] Connection error:", extractErrorMessage(error));
    });

  }

  return bullWorkerConnection;

}

/*
==================================================
RATE LIMIT CONNECTION
==================================================

Rate limiting is explicitly a fail-open, best-effort
feature (see app.ts: skipOnError: true on the
@fastify/rate-limit registration) - a Redis outage
must never block real traffic on abuse protection.

But skipOnError only decides what happens AFTER the
rate-limit store's Redis command fails; it does not
make that command fail any faster. Confirmed live:
sharing the main client's connectTimeoutMs (10s
default, chosen to tolerate real network hiccups for
business-critical operations like BullMQ/idempotency)
meant EVERY request - including ones that touch no
other infrastructure at all - took 10+ extra seconds
during a Redis outage before the rate-limit check
gave up and let the request through. That is an
effective full outage for any client with a normal
~10s timeout, despite the API technically still being
"up".

This dedicated connection fails fast instead: a short
connectTimeout and a single retry attempt, so
"fail open" during an outage actually means fast, not
just eventually-unblocked. It does not touch the main
client's more patient settings, which remain correct
for the business-critical Redis usage that needs them.
==================================================
*/

let rateLimitConnection: Redis | null = null;

export function getRateLimitRedisConnection(): Redis {

  if (!rateLimitConnection) {

    rateLimitConnection = new Redis(config.redis.url, {
      connectTimeout: 1_000,
      maxRetriesPerRequest: 1,
      retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
    });

    rateLimitConnection.on("error", (error) => {
      console.error("[Redis:RateLimit] Connection error:", extractErrorMessage(error));
    });

  }

  return rateLimitConnection;

}

/*
==================================================
IDEMPOTENCY CONNECTION
==================================================

Idempotency (see src/redis/idempotency.ts, used by
POST /send) guards a genuinely side-effecting
operation - unlike rate limiting, which is
deliberately fail-OPEN/best-effort, an idempotency
check that can't be established must fail CLOSED: if
we can't prove an operation hasn't already run, we
must not risk running it again.

But failing closed still requires failing FAST. A
slow-but-eventually-rejecting idempotency check would
just relocate the exact bug this project exists to
fix (POST /verify/batch/async hanging for the full
duration of a Redis outage) onto POST /send instead.
maxRetriesPerRequest here also matters for a second
reason beyond speed: it bounds how many times ioredis
retries a QUEUED command before giving up on it and
rejecting - past that bound, ioredis drops the
command instead of leaving it queued to eventually
fire once Redis reconnects. Without that bound, an
idempotency claim issued during an outage could
silently "land" long after the HTTP response was
already sent, an unsupervised side effect with no
caller left to observe it.

Same fail-fast settings as the rate-limit connection,
but a SEPARATE dedicated connection - not shared with
it - because the two fail in opposite directions
(open vs closed) and conflating them would blur that
distinction for a future reader.
==================================================
*/

let idempotencyConnection: Redis | null = null;

export function getIdempotencyRedisConnection(): Redis {

  if (!idempotencyConnection) {

    idempotencyConnection = new Redis(config.redis.url, {
      connectTimeout: 1_000,
      maxRetriesPerRequest: 1,
      retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
    });

    idempotencyConnection.on("error", (error) => {
      console.error("[Redis:Idempotency] Connection error:", extractErrorMessage(error));
    });

  }

  return idempotencyConnection;

}

export async function pingRedis(): Promise<boolean> {

  try {

    const response = await getRedis().ping();
    return response === "PONG";

  } catch {

    return false;

  }

}

export async function closeRedis(): Promise<void> {

  if (client) {
    await client.quit();
    client = null;
  }

  if (bullConnection) {
    await bullConnection.quit();
    bullConnection = null;
  }

  if (bullWorkerConnection) {
    await bullWorkerConnection.quit();
    bullWorkerConnection = null;
  }

  if (rateLimitConnection) {
    await rateLimitConnection.quit();
    rateLimitConnection = null;
  }

  if (idempotencyConnection) {
    await idempotencyConnection.quit();
    idempotencyConnection = null;
  }

}
