import DatabaseConstructor, {
  type Database as BetterSqlite3Database
} from "better-sqlite3";

import fs from "node:fs";
import path from "node:path";

import {
  runMigrations
} from "./migrations.js";


/*
DATABASE_PATH allows tests and deployments to point
at an isolated database file instead of the default
local development path.
*/

const databasePath =
  process.env.DATABASE_PATH
    ? path.resolve(
        process.env.DATABASE_PATH
      )
    : path.join(
        path.resolve(
          process.cwd(),
          "data"
        ),
        "email-intelligence.db"
      );


fs.mkdirSync(
  path.dirname(
    databasePath
  ),
  {
    recursive:true
  }
);


export type DatabaseConnection =
  BetterSqlite3Database;



const database: DatabaseConnection =
  new DatabaseConstructor(
    databasePath
  );


database.pragma(
  "journal_mode = WAL"
);


database.pragma(
  "foreign_keys = ON"
);


database.pragma(
  "busy_timeout = 5000"
);



runMigrations(database);


export function getDatabase(): DatabaseConnection {

  return database;

}



export function closeDatabase(): void {

  if(database.open){

    database.close();

  }

}



export default database;