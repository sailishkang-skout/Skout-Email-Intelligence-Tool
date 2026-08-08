import "./observability/tracing.js";

import { runMigrations } from "./database/migrations.js";
import { getDatabase, closeDatabase } from "./database/database.js";
import { closeRedis } from "./redis/redisClient.js";
import { config } from "./config/config.js";
import { shutdownTracing } from "./observability/tracing.js";
import { ensureBucketExists } from "./storage/storageProvider.js";

await runMigrations(getDatabase());

try {
	await ensureBucketExists();
} catch (error) {
	// Storage is used for large-artifact features that don't exist
	// yet (see storageProvider.ts) — don't block API startup on it,
	// but do surface the failure loudly since /readiness also checks
	// it and operators should know why readiness might be degraded.
	console.error("[Startup] Failed to ensure storage bucket exists:", error);
}

const { default: app } = await import("./app.js");

try {
	await app.listen({
		port: config.server.port,
		host: config.server.host,
	});

	app.log.info(
		`Email intelligence service listening on ${config.server.host}:${config.server.port}`
	);
} catch (error) {
	app.log.error(error);
	process.exit(1);
}

/*
==================================================
GRACEFUL SHUTDOWN
==================================================

The API process no longer runs verification work
inline (see src/worker.ts for that) — it only needs
to release the HTTP server, database pool, and Redis
connection cleanly.
==================================================
*/

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
	if (shuttingDown) {
		return;
	}

	shuttingDown = true;

	app.log.info(`Received ${signal}, shutting down gracefully...`);

	try {
		await app.close();
	} catch (error) {
		app.log.error(error, "Error while closing HTTP server");
	}

	try {
		await closeRedis();
	} catch (error) {
		app.log.error(error, "Error while closing Redis connection");
	}

	try {
		await closeDatabase();
	} catch (error) {
		app.log.error(error, "Error while closing database connection");
	}

	try {
		await shutdownTracing();
	} catch (error) {
		app.log.error(error, "Error while shutting down tracing");
	}

	process.exit(0);
}

process.on("SIGTERM", () => {
	void shutdown("SIGTERM");
});

process.on("SIGINT", () => {
	void shutdown("SIGINT");
});
