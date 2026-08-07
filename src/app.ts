import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";

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

const app = Fastify({
logger: true,
});

await app.register(cors, {
origin: true,
});

await app.register(helmet);

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

app.get("/", async () => {
return {
service: "Email Intelligence Service",
version: "1.0.0",
status: "running",
};
});

app.get("/health", async () => {
return {
status: "ok",
service: "email-verifier",
timestamp: new Date().toISOString(),
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
