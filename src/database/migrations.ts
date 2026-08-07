import fs from "node:fs";
import path from "node:path";

import type {
  DatabaseConnection
} from "./database.js";


export function runMigrations(
  db: DatabaseConnection
){

  db.exec(`

    CREATE TABLE IF NOT EXISTS migrations (

      id TEXT PRIMARY KEY,

      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP

    );

  `);



  const migrationDirectory =
    path.resolve(
      process.cwd(),
      "src/db/migrations"
    );



  const files =
    fs.readdirSync(
      migrationDirectory
    )
    .filter(
      file =>
        file.endsWith(".sql")
    )
    .sort();



  const applied =
    db.prepare(`
      SELECT id
      FROM migrations
    `)
    .all()
    .map(
      (row:any)=>row.id
    );



  for(
    const file of files
  ){

    if(
      applied.includes(file)
    ){
      continue;
    }



    const sql =
      fs.readFileSync(
        path.join(
          migrationDirectory,
          file
        ),
        "utf8"
      );



    const transaction =
      db.transaction(
        ()=>{

          db.exec(sql);


          db.prepare(`
  INSERT INTO migrations(
    id,
    executed_at
  )
  VALUES(
    ?,
    CURRENT_TIMESTAMP
  )
`)
.run(file);

        }
      );



    transaction();



    console.log(
      "Migration applied:",
      file
    );

  }

}