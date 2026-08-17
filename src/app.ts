import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";

import { config, LOG_REDACT_PATHS } from "./config/config.js";
import { getRateLimitRedisConnection } from "./redis/redisClient.js";
import { extractErrorMessage } from "./utils/errorMessage.js";

import verifyRoutes from "./routes/verify.js";
import verifyBatchRoutes from "./routes/verifyBatch.js";
import patternRoutes from "./routes/patterns.js";
import patternRankRoutes from "./routes/patternRank.js";
import smtpVerifyRoutes from "./routes/smtpVerify.js";
import smtpCatchAllRoutes from "./routes/smtpCatchAll.js";
import sendRoutes from "./routes/send.js";
import emailDiscoveryRoutes from "./routes/emailDiscovery.js";
import cacheRoutes from "./routes/cache.js";
import evidenceLedgerRoutes from "./routes/evidenceLedger.js";
import healthRoutes from "./routes/health.js";
import warmupRoutes from "./routes/warmup.js";
import metricsRoutes from "./observability/metricsRoute.js";

const app = Fastify({
logger: {
	level: process.env.LOG_LEVEL ?? "info",
	redact: {
		paths: LOG_REDACT_PATHS,
		censor: "[REDACTED]",
	},
},
// Every request gets a correlation ID: the caller's X-Request-Id if
// supplied, otherwise a generated UUID. This propagates through
// every structured log line (as reqId) so a single request can be
// traced across the API and, once it enqueues async work, through
// the worker logs too (the same id is threaded into queue jobs).
genReqId: (request) => {
	const header = request.headers["x-request-id"];
	if (typeof header === "string" && header.trim()) {
		return header.trim();
	}
	return randomUUID();
},
// Explicit request body cap. This service never legitimately
// needs large payloads (batch verification is capped separately
// at the route level), so bound it to stop oversized requests
// from consuming memory.
bodyLimit: config.server.bodyLimitBytes,
});

app.addHook("onSend", async (request, reply, payload) => {
	reply.header("x-request-id", request.id);
	return payload;
});

await app.register(cors, {
origin: true,
});

await app.register(helmet);

// Baseline abuse protection. This service performs live SMTP/DNS
// lookups against third-party mail servers on behalf of callers,
// so unrestricted request volume is a real abuse vector (both
// against this service's own resources and against the mail
// servers it queries).
//
// Backed by Redis rather than an in-memory store: with multiple API
// instances behind a load balancer, a process-local rate limiter
// would let a caller get `max` requests PER INSTANCE rather than
// per deployment, which defeats the point at any real scale.
await app.register(rateLimit, {
max: config.rateLimit.max,
timeWindow: config.rateLimit.windowMs,
// A dedicated, fast-failing connection - not the main shared
// client. skipOnError below only controls what happens AFTER the
// store read fails; it does not make that failure happen any
// faster. Sharing the main client's patient ~10s connectTimeout
// (correct for business-critical Redis usage like BullMQ) meant
// EVERY request, even ones touching no other infrastructure,
// took 10+ extra seconds during a Redis outage. See
// getRateLimitRedisConnection() for the full story.
redis: getRateLimitRedisConnection(),
nameSpace: "rate-limit:",
// A Redis outage must not take down the entire API. Without this,
// every request - including /health, whose whole purpose is to
// report a Redis outage cleanly - fails with a raw ioredis error
// because the rate-limit store itself can't be reached. Abuse
// protection failing open during a Redis outage is the standard,
// intended tradeoff: it is not a security boundary, and refusing
// all traffic because the anti-abuse layer's own backing store
// hiccuped would make Redis a single point of failure for the
// whole service.
skipOnError: true,
});

const PUBLIC_PATHS = new Set(["/", "/health", "/liveness", "/readiness", "/metrics"]);

app.addHook("onRequest", async (request, reply) => {
	if (!config.apiKey) return;
	if (request.method === "OPTIONS") return;
	const path = request.url.split("?")[0] ?? "";
	if (PUBLIC_PATHS.has(path)) return;
	const provided =
		(typeof request.headers["x-api-key"] === "string" ? request.headers["x-api-key"] : "") ||
		(typeof request.headers.authorization === "string" &&
		request.headers.authorization.startsWith("Bearer ")
			? request.headers.authorization.slice(7)
			: "");
	if (!provided || provided !== config.apiKey) {
		return reply.code(401).send({ success: false, error: "invalid_or_missing_api_key" });
	}
});

await app.register(verifyRoutes);
await app.register(verifyBatchRoutes);

await app.register(patternRoutes);
await app.register(patternRankRoutes);

await app.register(smtpVerifyRoutes);
await app.register(smtpCatchAllRoutes);
await app.register(sendRoutes);

await app.register(emailDiscoveryRoutes);
await app.register(cacheRoutes);
await app.register(evidenceLedgerRoutes);
await app.register(healthRoutes);
await app.register(warmupRoutes);
await app.register(metricsRoutes);

app.get("/", async () => {
return {
service: "Email Intelligence Service",
version: "1.0.0",
status: "running",
};
});

app.setNotFoundHandler(async (request, reply) => {
return reply.code(404).send({
success: false,
error: "Route not found",
method: request.method,
path: request.url,
});
});

app.setErrorHandler(async (error, request, reply) => {
request.log.error(error);

const statusCode =
typeof error === "object" &&
error !== null &&
"statusCode" in error &&
typeof error.statusCode === "number" &&
error.statusCode >= 400 &&
error.statusCode < 600
? error.statusCode
: 500;

return reply.code(statusCode).send({
success: false,
error: extractErrorMessage(error),
});
});

export default app;
