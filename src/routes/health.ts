import type {
  FastifyInstance,
} from "fastify";

import {
  getDatabase,
} from "../database/database.js";

/*
==================================================
HEALTH ROUTE
==================================================

GET /health

Reports whether the service's dependencies are
actually reachable, not just that the HTTP server
is up. Used by orchestrators/load balancers to
decide whether to route traffic to this instance.
==================================================
*/

interface HealthCheckResult {
  status: "ok" | "error";
  latencyMs: number;
  error?: string;
}

function checkDatabase(): HealthCheckResult {
  const start = Date.now();

  try {
    const db = getDatabase();

    db.prepare("SELECT 1").get();

    return {
      status: "ok",
      latencyMs: Date.now() - start,
    };
  } catch (error: unknown) {
    return {
      status: "error",
      latencyMs: Date.now() - start,
      error:
        error instanceof Error
          ? error.message
          : String(error),
    };
  }
}

export default async function healthRoutes(
  app: FastifyInstance
): Promise<void> {
  app.get("/health", async (_request, reply) => {
    const database = checkDatabase();

    const healthy = database.status === "ok";

    return reply
      .code(healthy ? 200 : 503)
      .send({
        status: healthy ? "ok" : "degraded",
        service: "email-intelligence-service",
        timestamp: new Date().toISOString(),
        checks: {
          database,
        },
      });
  });
}
