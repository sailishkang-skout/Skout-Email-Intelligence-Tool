import {
  getDatabase
} from "./database.js";


/**
 * ==================================================
 * TRANSACTION HELPER
 * ==================================================
 *
 * Centralized SQLite transaction wrapper.
 *
 * All repositories should use this helper.
 *
 * Benefits:
 *
 * - single transaction implementation
 * - consistent rollback behavior
 * - easier testing
 * - easier database migration later
 *
 * ==================================================
 */


export function withTransaction<T>(
  callback: () => T
): T {

  const transaction =
    getDatabase().transaction(
      callback
    );

  return transaction();

}


/**
 * Alias
 */

export const runInTransaction =
  withTransaction;