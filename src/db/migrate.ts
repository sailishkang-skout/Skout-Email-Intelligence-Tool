/*
==================================================
MIGRATION CLI
==================================================

Thin CLI entry point for running database
migrations outside of normal server startup
(e.g. in CI/CD or a deploy step).

This intentionally delegates to the canonical
migration runner in src/database/migrations.ts.

There must be only one migration implementation.
==================================================
*/

import { getDatabase, closeDatabase } from "../database/database.js";

// Importing database.ts already runs migrations as
// a side effect (see src/database/database.ts). This
// entry point exists so migrations can be run/verified
// explicitly (e.g. `npm run migrate`) without starting
// the HTTP server.

getDatabase();

console.log("Database migrations complete.");

closeDatabase();
