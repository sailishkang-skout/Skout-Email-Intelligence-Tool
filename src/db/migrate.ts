import fs from "node:fs";
import path from "node:path";

import {
  getDatabase
} from "../database/database.js";


const db =
  getDatabase();


const migrationsDirectory =
  path.resolve(
    process.cwd(),
    "src/db/migrations"
  );


db.exec(`
CREATE TABLE IF NOT EXISTS migrations (

  id TEXT PRIMARY KEY,

  executed_at TEXT NOT NULL

);
`);


const applied =
  new Set(
    (
      db.prepare(
        `
        SELECT id
        FROM migrations
        `
      )
      .all() as {
        id:string
      }[]
    )
    .map(
      row => row.id
    )
  );


const migrationFiles =
  fs.readdirSync(
    migrationsDirectory
  )
  .filter(
    file =>
      file.endsWith(".sql")
  )
  .sort();


for (
  const file
  of migrationFiles
) {


  if (
    applied.has(file)
  ) {
    console.log(
      `Skipping ${file}`
    );

    continue;
  }


  const sql =
    fs.readFileSync(
      path.join(
        migrationsDirectory,
        file
      ),
      "utf8"
    );


  console.log(
    `Running ${file}`
  );


  const runMigration =
    db.transaction(
      () => {

        db.exec(sql);


        db.prepare(
          `
          INSERT INTO migrations
          (
            id,
            executed_at
          )
          VALUES
          (
            ?,
            ?
          )
          `
        )
        .run(
          file,
          new Date()
            .toISOString()
        );

      }
    );


  runMigration();


  console.log(
    `Completed ${file}`
  );

}


console.log(
  "Database migrations complete."
);
