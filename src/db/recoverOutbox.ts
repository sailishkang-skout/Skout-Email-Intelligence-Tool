/*
==================================================
OUTBOX DEAD-LETTER RECOVERY CLI
==================================================

Thin CLI entry point for recovering permanently-FAILED
verification_outbox rows (see recoverFailedOutboxRows()
and getOutboxSummary() in verificationJobService.ts).

This is a deliberately separate, explicitly-invoked
action - NOT something the dispatcher does on its own
poll loop. A row only reaches FAILED after exhausting
MAX_OUTBOX_ATTEMPTS (an hour or more of retrying at
capped backoff); silently auto-recovering it would
either mean it was never really dead-lettered at all
(defeating the point - a permanently-broken row would
spin forever) or would hide a real, operator-worthy
problem behind automatic retries forever.

There is no HTTP admin route for this: this service has
no existing authentication/authorization model for any
route (every route is currently open), and inventing one
solely for this action would be exactly the kind of new
infrastructure this hardening pass is supposed to avoid.
A CLI invoked by whoever/whatever already has operational
access to run one-off scripts against this service
(matching migrate.ts's own precedent) is the appropriate
mechanism here instead.

Usage:

  npm run recover-outbox            # summary only, no changes
  npm run recover-outbox -- --apply # actually recover FAILED rows
==================================================
*/

import { getDatabase, closeDatabase } from "../database/database.js";
import {
  getOutboxSummary,
  recoverFailedOutboxRows,
} from "../services/verificationJobService.js";

function formatAge(ageMs: number | null): string {
  if (ageMs === null) {
    return "n/a";
  }
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

// Ensures the connection pool this CLI shares with the rest of the
// codebase is actually reachable before reporting anything, matching
// migrate.ts's own startup behavior.
await getDatabase().query("SELECT 1");

const summary = await getOutboxSummary();

console.log("Outbox summary:");
console.log(`  PENDING:    ${summary.pending.count} (oldest: ${formatAge(summary.pending.oldestAgeMs)})`);
console.log(`  DISPATCHED: ${summary.dispatched.count} (oldest: ${formatAge(summary.dispatched.oldestAgeMs)})`);
console.log(`  FAILED:     ${summary.failed.count} (oldest: ${formatAge(summary.failed.oldestAgeMs)})`);

const shouldApply = process.argv.includes("--apply");

if (summary.failed.count === 0) {

  console.log("\nNo FAILED outbox rows to recover.");

} else if (!shouldApply) {

  console.log(
    `\n${summary.failed.count} FAILED row(s) found. Re-run with --apply to reset them back to PENDING ` +
      "(fresh attempt budget; the normal dispatcher poll will pick them up and re-enqueue via the same idempotent path as any other pending row - no duplicate work)."
  );

} else {

  const result = await recoverFailedOutboxRows();

  console.log(`\nRecovered ${result.recoveredCount} row(s):`);
  for (const id of result.recoveredIds) {
    console.log(`  ${id}`);
  }

}

await closeDatabase();
