import pg from "pg";

import { config } from "../config/config.js";

/*
==================================================
POSTGRESQL CONNECTION POOL
==================================================

Single pooled connection, shared by every
repository. Business logic must never reach for
`pg` directly — go through getDatabase()/query()
so pooling, timeouts, and SSL configuration stay
centralized here.
==================================================
*/

export type DatabaseConnection = pg.Pool;

const pool = new pg.Pool({
  connectionString: config.database.url,
  max: config.database.poolMax,
  idleTimeoutMillis: config.database.idleTimeoutMs,
  connectionTimeoutMillis: config.database.connectionTimeoutMs,
  ssl: config.database.ssl
    ? {
        // Managed Postgres providers (RDS, Supabase, etc.) commonly
        // terminate TLS with certificates that aren't in Node's
        // default trust store reachable from arbitrary hosts. This
        // still encrypts the connection; it does not disable TLS.
        rejectUnauthorized: false,
      }
    : false,
});

pool.on("error", (error) => {
  // Errors on idle clients (e.g. connection reset by the server)
  // must not crash the process — the pool will create a fresh
  // connection on the next query.
  console.error("[Database] Unexpected error on idle client:", error);
});

export function getDatabase(): DatabaseConnection {
  return pool;
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}

export interface DatabaseHealthInfo {
  currentUser: string;
  currentDatabase: string;
  version: string;
  serverTime: string;
}

export async function pingDatabase(): Promise<boolean>;
export async function pingDatabase(extended: true): Promise<DatabaseHealthInfo>;
export async function pingDatabase(extended?: boolean): Promise<boolean | DatabaseHealthInfo> {
  try {
    const result = await pool.query(`
      SELECT 
        current_user, 
        current_database,
        version(),
        NOW() as current_time
    `);
    
    if (extended) {
      return {
        currentUser: result.rows[0].current_user,
        currentDatabase: result.rows[0].current_database,
        version: result.rows[0].version.split(" ")[0],
        serverTime: result.rows[0].current_time
      };
    }
    
    return true;
  } catch {
    return false;
  }
}

export default pool;