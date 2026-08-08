import client from "prom-client";

import { config } from "../config/config.js";

/*
==================================================
METRICS
==================================================

Prometheus-format metrics for the API and worker
processes. A single registry is shared by both (each
process only populates the metrics it actually emits
— e.g. the worker never records HTTP metrics).
==================================================
*/

export const registry = new client.Registry();

registry.setDefaultLabels({
  service: config.observability.serviceName,
});

if (config.observability.metricsEnabled) {
  client.collectDefaultMetrics({ register: registry });
}

/*
==================================================
HTTP METRICS
==================================================
*/

export const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status_code"],
  registers: [registry],
});

/*
==================================================
VERIFICATION METRICS
==================================================
*/

export const verificationDuration = new client.Histogram({
  name: "verification_duration_seconds",
  help: "Email verification duration in seconds",
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 20, 30],
  registers: [registry],
});

export const verificationsTotal = new client.Counter({
  name: "verifications_total",
  help: "Total email verifications performed",
  labelNames: ["status", "decision"],
  registers: [registry],
});

export const verificationErrorsTotal = new client.Counter({
  name: "verification_errors_total",
  help: "Total email verification errors",
  labelNames: ["stage"],
  registers: [registry],
});

/*
==================================================
QUEUE / WORKER METRICS
==================================================
*/

export const queueJobsTotal = new client.Counter({
  name: "queue_jobs_total",
  help: "Total queue jobs processed",
  labelNames: ["queue", "outcome"], // outcome: completed | failed | retried
  registers: [registry],
});

export const queueJobDuration = new client.Histogram({
  name: "queue_job_duration_seconds",
  help: "Queue job processing duration in seconds",
  labelNames: ["queue"],
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 20, 30, 60],
  registers: [registry],
});

export const queueDepthGauge = new client.Gauge({
  name: "queue_depth",
  help: "Current queue depth by state",
  labelNames: ["queue", "state"], // state: waiting | active | delayed | failed
  registers: [registry],
});

/*
==================================================
RATE LIMIT / PROVIDER METRICS
==================================================
*/

export const rateLimitHitsTotal = new client.Counter({
  name: "rate_limit_hits_total",
  help: "Total requests rejected by rate limiting",
  labelNames: ["route"],
  registers: [registry],
});

export const providerFailuresTotal = new client.Counter({
  name: "provider_failures_total",
  help: "Total external provider (SMTP/DNS) failures",
  labelNames: ["provider", "reason"],
  registers: [registry],
});
