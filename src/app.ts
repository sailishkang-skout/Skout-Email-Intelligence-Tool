import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";

import { config, LOG_REDACT_PATHS } from "./config/config.js";
import { getRedis } from "./redis/redisClient.js";

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
redis: getRedis(),
nameSpace: "rate-limit:",
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
error:
error instanceof Error
? error.message
: String(error),
});
});

export default app;
