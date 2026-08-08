/*
==================================================
MIGRATION CLI
==================================================

Thin CLI entry point for running database
migrations outside of normal server startup
(e.g. in CI/CD or a deploy step).

This intentionally delegates to the canonical
migration runner in src/database/migrations.ts —
there must be only one migration implementation.
==================================================
*/

import { getDatabase, closeDatabase } from "../database/database.js";
import { runMigrations } from "../database/migrations.js";

await runMigrations(getDatabase());

console.log("Database migrations complete.");

await closeDatabase();
