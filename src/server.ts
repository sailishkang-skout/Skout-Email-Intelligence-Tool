import app from "./app.js";
import { closeDatabase } from "./database/database.js";
import { startVerificationRetryScheduler } from "./services/verificationRetryScheduler.js";

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? "0.0.0.0";

const RETRY_SCHEDULER_INTERVAL_MS = Number(
	process.env.RETRY_SCHEDULER_INTERVAL_MS ?? 10_000
);

try {
	await app.listen({
		port: PORT,
		host: HOST,
	});

	app.log.info(
		`Email intelligence service listening on ${HOST}:${PORT}`
	);
} catch (error) {
	app.log.error(error);
	process.exit(1);
}

const retryScheduler = startVerificationRetryScheduler(
	RETRY_SCHEDULER_INTERVAL_MS
);

app.log.info(
	`Verification retry scheduler started (interval: ${RETRY_SCHEDULER_INTERVAL_MS}ms)`
);

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
	if (shuttingDown) {
		return;
	}

	shuttingDown = true;

	app.log.info(`Received ${signal}, shutting down gracefully...`);

	retryScheduler.stop();

	try {
		await app.close();
	} catch (error) {
		app.log.error(error, "Error while closing HTTP server");
	}

	try {
		closeDatabase();
	} catch (error) {
		app.log.error(error, "Error while closing database connection");
	}

	process.exit(0);
}

process.on("SIGTERM", () => {
	void shutdown("SIGTERM");
});

process.on("SIGINT", () => {
	void shutdown("SIGINT");
});
