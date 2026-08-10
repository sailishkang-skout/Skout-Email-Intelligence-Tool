import fs from "node:fs";
import path from "node:path";

import type { DatabaseConnection } from "./database.js";

/*
==================================================
MIGRATION RUNNER
==================================================

Wrapped in a PostgreSQL session-level advisory lock
so that concurrent processes starting at the same
time (e.g. an API instance and a worker instance
both booting during a deploy) don't race to apply
the same pending migration — the second process
would otherwise hit a duplicate-key error on the
migrations table's primary key and crash at startup.
Losing the race just means waiting; the winner
applies migrations, and the loser then sees them all
already applied and does nothing.

The lock key is an arbitrary fixed constant (any
int8 works — it just needs to be consistent).
==================================================
*/

const MIGRATION_LOCK_KEY = 727_001;

export async function runMigrations(
  db: DatabaseConnection
): Promise<void> {

  const client = await db.connect();

  // Set only if something below fails, so the connection is
  // destroyed (release(error)) rather than returned to the pool in a
  // potentially-corrupted state.
  let releaseError: Error | undefined;

  try {

    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id TEXT PRIMARY KEY,
        executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const migrationDirectory =
      path.resolve(
        process.cwd(),
        "src/db/migrations"
      );

    const files =
      fs.readdirSync(migrationDirectory)
        .filter(file => file.endsWith(".sql"))
        .sort();

    const { rows: appliedRows } =
      await client.query<{ id: string }>(
        "SELECT id FROM migrations"
      );

    const applied = new Set(appliedRows.map(row => row.id));

    for (const file of files) {

      if (applied.has(file)) {
        continue;
      }

      const sql =
        fs.readFileSync(
          path.join(migrationDirectory, file),
          "utf8"
        );

      try {

        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO migrations (id, executed_at) VALUES ($1, NOW())",
          [file]
        );
        await client.query("COMMIT");

      } catch (error) {

        releaseError =
          error instanceof Error ? error : new Error(String(error));

        // A rollback failure must never replace the original
        // migration error in what gets thrown.
        await client.query("ROLLBACK").catch((rollbackError: unknown) => {
          console.error(
            "[Migrations] Rollback failed after a failed migration:",
            rollbackError
          );
        });

        throw error;

      }

      console.log("Migration applied:", file);

    }

  } catch (error) {

    // Covers failures OUTSIDE the per-migration loop's own try/catch
    // above (e.g. the advisory lock query itself, or listing/reading
    // migration files) - those already-thrown errors would otherwise
    // skip straight to `finally` below without ever marking this
    // connection for destruction.
    releaseError ??=
      error instanceof Error ? error : new Error(String(error));

    throw error;

  } finally {

    // Skip the unlock query on an already-broken connection - it
    // would only throw again and mask whatever is already being
    // propagated. A dead connection's advisory lock is released
    // automatically by Postgres when the session ends anyway.
    if (!releaseError) {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch((unlockError: unknown) => {
        console.error("[Migrations] Failed to release advisory lock:", unlockError);
      });
    }

    client.release(releaseError);

  }

}
