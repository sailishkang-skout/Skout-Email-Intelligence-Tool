import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";

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

const app = Fastify({
logger: true,
// Explicit request body cap. This service never legitimately
// needs large payloads (batch verification is capped separately
// at the route level), so bound it to stop oversized requests
// from consuming memory.
bodyLimit: 1024 * 1024, // 1MB
});

await app.register(cors, {
origin: true,
});

await app.register(helmet);

// Baseline abuse protection. This service performs live SMTP/DNS
// lookups against third-party mail servers on behalf of callers,
// so unrestricted request volume is a real abuse vector (both
// against this service's own resources and against the mail
// servers it queries). Tunable per deployment via env vars.
await app.register(rateLimit, {
max: Number(process.env.RATE_LIMIT_MAX ?? 120),
timeWindow: process.env.RATE_LIMIT_WINDOW ?? "1 minute",
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
