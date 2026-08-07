import {
  getDatabase
} from "../src/database/database.js";

import {
  runDueRetries
} from "../src/services/verificationRetryScheduler.js";


async function main() {

  const db =
    getDatabase();


  const before =
    db.prepare(`
      SELECT
        email,
        status,
        retry_count,
        max_retries,
        next_attempt_at
      FROM verification_job_items
      WHERE status = 'PENDING'
      ORDER BY created_at DESC
    `)
    .all();


  console.log(
    "\nDUE RETRIES BEFORE:",
    before
  );


  const results =
    await runDueRetries();


  console.log(
    "\nRETRY RESULTS:",
    results
  );


  const after =
    db.prepare(`
      SELECT
        email,
        status,
        retry_count,
        max_retries,
        attempt_count,
        next_attempt_at
      FROM verification_job_items
      ORDER BY created_at DESC
      LIMIT 10
    `)
    .all();


  console.log(
    "\nITEMS AFTER:",
    after
  );

}


main()
  .catch(
    error => {

      console.error(
        error
      );

      process.exit(
        1
      );

    }
  );
