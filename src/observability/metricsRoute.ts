import type { FastifyInstance } from "fastify";

import { registry, httpRequestDuration, httpRequestsTotal } from "./metrics.js";

/*
==================================================
METRICS ROUTE
==================================================

GET /metrics — Prometheus scrape endpoint.

Also installs request hooks that record HTTP metrics
for every route in the app (registered once here so
individual route files don't need to instrument
themselves).
==================================================
*/

export default async function metricsRoutes(
  app: FastifyInstance
): Promise<void> {

  app.addHook("onRequest", async (request) => {
    (request as { metricsStart?: bigint }).metricsStart =
      process.hrtime.bigint();
  });

  app.addHook("onResponse", async (request, reply) => {

    const start = (request as { metricsStart?: bigint }).metricsStart;

    const durationSeconds =
      start
        ? Number(process.hrtime.bigint() - start) / 1e9
        : 0;

    // Use the matched route pattern (e.g. "/verify/jobs/:jobId"),
    // not the raw URL, so metrics don't explode into one series per
    // unique id.
    const route =
      request.routeOptions.url ?? request.url;

    const labels = {
      method: request.method,
      route,
      status_code: String(reply.statusCode),
    };

    httpRequestDuration.observe(labels, durationSeconds);
    httpRequestsTotal.inc(labels);

  });

  app.get("/metrics", async (_request, reply) => {

    reply.header("Content-Type", registry.contentType);

    return registry.metrics();

  });

}
