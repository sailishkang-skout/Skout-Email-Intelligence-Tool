import { randomUUID } from "node:crypto";

import {
  getDatabase,
  type DatabaseConnection
} from "../database/database.js";

import {
  withTransaction
} from "../database/transaction.js";

import type {
  Statement,
  RunResult
} from "better-sqlite3";


/**
 * ==================================================
 * BASE REPOSITORY (ENTERPRISE v2)
 * ==================================================
 *
 * Purpose
 * -------
 * Common foundation for all repositories.
 *
 * Responsibilities
 * ----------------
 * - shared database connection
 * - transaction handling
 * - prepared statement caching
 * - typed query helpers
 * - generic CRUD helpers
 * - timestamp helpers
 * - UUID helper
 * - normalization utilities
 * - SQLite boolean conversion helpers
 *
 * This class intentionally contains NO business logic.
 *
 * ==================================================
 */

export abstract class BaseRepository {

  /**
   * ==================================================
   * DATABASE CONNECTION
   * ==================================================
   */

  protected readonly db: DatabaseConnection =
    getDatabase();


  /**
   * ==================================================
   * STATEMENT CACHE
   * ==================================================
   */

  private readonly statementCache =
    new Map<string, Statement>();


  /**
   * ==================================================
   * TRANSACTION
   * ==================================================
   */

  protected transaction<T>(
    callback: () => T
  ): T {

    return withTransaction(
      callback
    );

  }


  /**
   * ==================================================
   * PREPARE STATEMENT (CACHED)
   * ==================================================
   */

  protected prepare(
    sql: string
  ): Statement {

    const cached =
      this.statementCache.get(
        sql
      );

    if (cached) {
      return cached;
    }

    const statement =
      this.db.prepare(
        sql
      );

    this.statementCache.set(
      sql,
      statement
    );

    return statement;

  }


  /**
   * ==================================================
   * EXECUTE RAW SQL
   * ==================================================
   */

  protected exec(
    sql: string
  ): void {

    this.db.exec(
      sql
    );

  }


  /**
   * ==================================================
   * QUERY ONE
   * ==================================================
   */

  protected queryOne<T>(
    sql: string,
    ...params: unknown[]
  ): T | null {

    const row =
      this.prepare(sql).get(
        ...params
      ) as T | undefined;

    return row ?? null;

  }


  /**
   * ==================================================
   * QUERY MANY
   * ==================================================
   */

  protected queryMany<T>(
    sql: string,
    ...params: unknown[]
  ): T[] {

    return this.prepare(sql).all(
      ...params
    ) as T[];

  }


  /**
   * ==================================================
   * RUN STATEMENT
   * ==================================================
   */

  protected executeRun(
    sql: string,
    ...params: unknown[]
  ): RunResult {

    return this.prepare(sql).run(
      ...params
    );

  }


  /**
   * ==================================================
   * EXISTS CHECK
   * ==================================================
   */

  protected exists(
    sql: string,
    ...params: unknown[]
  ): boolean {

    const row =
      this.prepare(sql).get(
        ...params
      ) as
        | Record<string, unknown>
        | undefined;

    if (!row) {
      return false;
    }

    const value =
      Object.values(row)[0];

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

  protected scalar<T>(
    sql: string,
    ...params: unknown[]
  ): T | null {

    const row =
      this.prepare(sql).get(
        ...params
      ) as
        | Record<string, unknown>
        | undefined;

    if (!row) {
      return null;
    }

    const values =
      Object.values(row);

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

  protected count(
    sql: string,
    ...params: unknown[]
  ): number {

    return this.scalar<number>(
      sql,
      ...params
    ) ?? 0;

  }


  /**
   * ==================================================
   * INSERT HELPER
   * ==================================================
   */

  protected executeInsert(
    sql: string,
    ...params: unknown[]
  ): number {

    const result =
      this.executeRun(
        sql,
        ...params
      );

    return Number(
      result.lastInsertRowid
    );

  }


  /**
   * ==================================================
   * UPDATE HELPER
   * ==================================================
   */

  protected executeUpdate(
    sql: string,
    ...params: unknown[]
  ): number {

    const result =
      this.executeRun(
        sql,
        ...params
      );

    return result.changes;

  }


  /**
   * ==================================================
   * DELETE HELPER
   * ==================================================
   */

  protected executeDelete(
    sql: string,
    ...params: unknown[]
  ): number {

    const result =
      this.executeRun(
        sql,
        ...params
      );

    return result.changes;

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
   * UNIX TIME
   * ==================================================
   */

  protected unixTime(): number {

    return Math.floor(
      Date.now() / 1000
    );

  }


  /**
   * ==================================================
   * SQLITE BOOLEAN HELPERS
   * ==================================================
   */

  protected sqliteBool(
    value: boolean | null | undefined
  ): number | null {

    if (
      value === null ||
      value === undefined
    ) {
      return null;
    }

    return value ? 1 : 0;

  }


  protected bool(
    value: unknown
  ): boolean {

    return value === 1 ||
      value === true ||
      value === "1";

  }


  protected nullableBool(
    value: unknown
  ): boolean | null {

    if (
      value === null ||
      value === undefined
    ) {
      return null;
    }

    return this.bool(value);

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


  /**
   * ==================================================
   * CLEAR STATEMENT CACHE
   * ==================================================
   */

  protected clearStatementCache(): void {

    this.statementCache.clear();

  }

}