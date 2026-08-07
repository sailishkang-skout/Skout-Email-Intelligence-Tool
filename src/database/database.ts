import DatabaseConstructor, {
  type Database as BetterSqlite3Database
} from "better-sqlite3";

import fs from "node:fs";
import path from "node:path";

import {
  runMigrations
} from "./migrations.js";


const dataDirectory =
  path.resolve(
    process.cwd(),
    "data"
  );


fs.mkdirSync(
  dataDirectory,
  {
    recursive:true
  }
);


const databasePath =
  path.join(
    dataDirectory,
    "email-intelligence.db"
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