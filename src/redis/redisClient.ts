import { Redis } from "ioredis";

import { config } from "../config/config.js";

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
    console.error("[Redis] Connection error:", error.message);
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
connection.
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
      console.error("[Redis:BullMQ] Connection error:", error.message);
    });

  }

  return bullConnection;

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

}
