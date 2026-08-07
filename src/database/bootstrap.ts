import database from "./database.js";

import {
  runMigrations
} from "./migrations.js";


runMigrations(
  database
);