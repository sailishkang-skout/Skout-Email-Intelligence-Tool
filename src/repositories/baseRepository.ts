import { randomUUID } from "node:crypto";

import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  getDatabase,
  type DatabaseConnection
} from "../database/database.js";


/**
 * ==================================================
 * QUERY EXECUTOR
 * ==================================================
 *
 * Either the pool itself (auto-managed connection per
 * query) or a checked-out client inside a transaction.
 * Both expose the same `.query()` shape, so the query
 * helper methods below don't need to know which one
 * they're using.
 */
type QueryExecutor = Pool | PoolClient;


/**
 * ==================================================
 * BASE REPOSITORY
 * ==================================================
 *
 * Purpose
 * -------
 * Common foundation for all repositories.
 *
 * Responsibilities
 * ----------------
 * - shared PostgreSQL connection pool
 * - transaction handling
 * - typed query helpers
 * - generic CRUD helpers
 * - timestamp/UUID helpers
 *
 * This class intentionally contains NO business logic.
 *
 * ==================================================
 */

export abstract class BaseRepository {

  protected readonly db: DatabaseConnection =
    getDatabase();


  /**
   * ==================================================
   * TRANSACTION
   * ==================================================
   *
   * Runs `callback` against a single checked-out client
   * inside a BEGIN/COMMIT block. Pass `tx` (not `this`)
   * to any query helper calls made inside the callback,
   * so they run on the same connection/transaction
   * rather than a different pooled connection.
   *
   * Example:
   *
   *     return this.withTransaction(async (tx) => {
   *       await this.executeDelete(sql, [x], tx);
   *       return this.executeDelete(sql2, [x], tx);
   *     });
   */

  protected async withTransaction<T>(
    callback: (tx: PoolClient) => Promise<T>
  ): Promise<T> {

    const client =
      await this.db.connect();

    try {

      await client.query("BEGIN");

      const result =
        await callback(client);

      await client.query("COMMIT");

      return result;

    } catch (error) {

      await client.query("ROLLBACK");

      throw error;

    } finally {

      client.release();

    }

  }


  /**
   * ==================================================
   * QUERY ONE
   * ==================================================
   */

  protected async queryOne<T extends QueryResultRow>(
    sql: string,
    params: unknown[] = [],
    executor: QueryExecutor = this.db
  ): Promise<T | null> {

    const result =
      await executor.query<T>(sql, params);

    return result.rows[0] ?? null;

  }


  /**
   * ==================================================
   * QUERY MANY
   * ==================================================
   */

  protected async queryMany<T extends QueryResultRow>(
    sql: string,
    params: unknown[] = [],
    executor: QueryExecutor = this.db
  ): Promise<T[]> {

    const result =
      await executor.query<T>(sql, params);

    return result.rows;

  }


  /**
   * ==================================================
   * RUN STATEMENT (INSERT/UPDATE/DELETE without a
   * meaningful return value)
   * ==================================================
   */

  protected async executeRun(
    sql: string,
    params: unknown[] = [],
    executor: QueryExecutor = this.db
  ): Promise<{ rowCount: number }> {

    const result =
      await executor.query(sql, params);

    return {
      rowCount: result.rowCount ?? 0
    };

  }


  /**
   * ==================================================
   * EXISTS CHECK
   * ==================================================
   */

  protected async exists(
    sql: string,
    params: unknown[] = [],
    executor: QueryExecutor = this.db
  ): Promise<boolean> {

    const result =
      await executor.query(sql, params);

    if (result.rows.length === 0) {
      return false;
    }

    const value =
      Object.values(
        result.rows[0] as Record<string, unknown>
      )[0];

    if (typeof value === "number") {
      return value > 0;
    }

    return Boolean(value);

  }


  /**
   * ==================================================
   * SCALAR QUERY
   * ==================================================
   */

  protected async scalar<T>(
    sql: string,
    params: unknown[] = [],
    executor: QueryExecutor = this.db
  ): Promise<T | null> {

    const result =
      await executor.query(sql, params);

    if (result.rows.length === 0) {
      return null;
    }

    const values =
      Object.values(result.rows[0] as Record<string, unknown>);

    if (values.length === 0) {
      return null;
    }

    return values[0] as T;

  }


  /**
   * ==================================================
   * COUNT HELPER
   * ==================================================
   */

  protected async count(
    sql: string,
    params: unknown[] = [],
    executor: QueryExecutor = this.db
  ): Promise<number> {

    const value =
      await this.scalar<number | string>(sql, params, executor);

    return Number(value ?? 0);

  }


  /**
   * ==================================================
   * INSERT HELPER
   * ==================================================
   *
   * Returns the inserted row's `id` when the statement
   * includes `RETURNING id`; otherwise returns null.
   */

  protected async executeInsert(
    sql: string,
    params: unknown[] = [],
    executor: QueryExecutor = this.db
  ): Promise<string | number | null> {

    const result =
      await executor.query(sql, params);

    const row =
      result.rows[0] as
        | Record<string, unknown>
        | undefined;

    if (!row) {
      return null;
    }

    const value = row.id;

    return (
      typeof value === "string" ||
      typeof value === "number"
    )
      ? value
      : null;

  }


  /**
   * ==================================================
   * UPDATE HELPER
   * ==================================================
   */

  protected async executeUpdate(
    sql: string,
    params: unknown[] = [],
    executor: QueryExecutor = this.db
  ): Promise<number> {

    const { rowCount } =
      await this.executeRun(sql, params, executor);

    return rowCount;

  }


  /**
   * ==================================================
   * DELETE HELPER
   * ==================================================
   */

  protected async executeDelete(
    sql: string,
    params: unknown[] = [],
    executor: QueryExecutor = this.db
  ): Promise<number> {

    const { rowCount } =
      await this.executeRun(sql, params, executor);

    return rowCount;

  }


  /**
   * ==================================================
   * UUID
   * ==================================================
   */

  protected uuid(): string {

    return randomUUID();

  }


  /**
   * ==================================================
   * CURRENT TIMESTAMP
   * ==================================================
   */

  protected now(): string {

    return new Date().toISOString();

  }


  /**
   * ==================================================
   * BOOLEAN HELPERS
   * ==================================================
   *
   * PostgreSQL has a native boolean type, so — unlike
   * the previous SQLite integer-flag encoding — these
   * are now near-passthroughs. Kept for a stable,
   * explicit call-site API and as a defensive coercion
   * boundary for any legacy 0/1 values still present in
   * data written before this migration.
   */

  protected sqliteBool(
    value: boolean | null | undefined
  ): boolean | null {

    if (value === null || value === undefined) {
      return null;
    }

    return Boolean(value);

  }


  protected bool(
    value: unknown
  ): boolean {

    return value === 1 ||
      value === true ||
      value === "1" ||
      value === "true";

  }


  protected nullableBool(
    value: unknown
  ): boolean | null {

    if (value === null || value === undefined) {
      return null;
    }

    return this.bool(value);

  }


  /**
   * ==================================================
   * DATE NORMALIZATION
   * ==================================================
   *
   * pg returns TIMESTAMPTZ columns as JS Date objects.
   * Existing interfaces throughout the codebase type
   * these fields as ISO strings; normalize here so
   * every repository returns the same shape it always
   * has, rather than leaking driver-specific types.
   */

  protected isoString(
    value: unknown
  ): string | null {

    if (value === null || value === undefined) {
      return null;
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    // Anything reaching here is a primitive TEXT/VARCHAR column
    // value from pg, not an object — String() is the intended
    // conversion, not an accidental "[object Object]".
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    return String(value);

  }


  /**
   * ==================================================
   * STRING NORMALIZATION
   * ==================================================
   */

  protected normalizeEmail(
    email: string
  ): string {

    return email
      .trim()
      .toLowerCase();

  }


  protected normalizeDomain(
    domain: string
  ): string {

    return domain
      .trim()
      .toLowerCase()
      .replace(
        /^https?:\/\//,
        ""
      )
      .replace(
        /^www\./,
        ""
      )
      .split("/")[0]
      ?.trim() ?? "";

  }


  protected normalizePattern(
    pattern: string
  ): string {

    return pattern
      .trim()
      .toLowerCase();

  }


  protected normalizeProvider(
    provider: string
  ): string {

    return provider
      .trim()
      .toLowerCase();

  }


  /**
   * ==================================================
   * NULLABLE STRING
   * ==================================================
   */

  protected nullableString(
    value?: string | null
  ): string | null {

    if (
      value === undefined ||
      value === null
    ) {
      return null;
    }

    const normalized =
      value.trim();

    return normalized || null;

  }


  /**
   * ==================================================
   * PAGINATION
   * ==================================================
   */

  protected paginate(
    page = 1,
    pageSize = 50
  ): {
    limit:number;
    offset:number;
  } {

    const safePage =
      Math.max(1, page);

    const safePageSize =
      Math.min(
        500,
        Math.max(1, pageSize)
      );

    return {
      limit:safePageSize,
      offset:(safePage - 1) * safePageSize
    };

  }

}
