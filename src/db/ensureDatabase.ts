/*
==================================================
DATABASE BOOTSTRAP CLI
==================================================

One-off idempotent step for shared-instance deploys:
connects to whatever database DATABASE_URL/DATABASE_NAME
currently point at (expected to be the RDS instance's
default maintenance database, e.g. "skout" — NOT this
service's own target database, which doesn't exist yet
on first deploy) and creates the target database if it's
missing.

Run this BEFORE src/db/migrate.ts on a shared Postgres
instance. Not needed when this service has its own
dedicated instance whose default database already is
the target.
==================================================
*/

import pg from "pg";

import { config } from "../config/config.js";

const targetDatabase = process.env.EMAIL_INTEL_TARGET_DATABASE ?? "email_intelligence";

const client = new pg.Client({
  connectionString: config.database.url,
  ssl: config.database.ssl ? { rejectUnauthorized: false } : false,
});

await client.connect();

try {
  const { rows } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [
    targetDatabase,
  ]);

  if (rows.length > 0) {
    console.log(`Database "${targetDatabase}" already exists.`);
  } else {
    // Database identifiers can't be parameterized — targetDatabase is
    // deploy-time config (an env var this process's own operator sets),
    // never end-user input.
    await client.query(`CREATE DATABASE "${targetDatabase.replace(/"/g, '""')}"`);
    console.log(`Created database "${targetDatabase}".`);
  }
} finally {
  await client.end();
}
