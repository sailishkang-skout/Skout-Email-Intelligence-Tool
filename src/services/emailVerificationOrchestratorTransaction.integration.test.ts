import { test, mock } from "node:test";
import assert from "node:assert/strict";

/*
Regression/failure-mode test for a real, confirmed production gap:
verifyEmail() used to write verification_results, then
verification_decisions, as two separate, non-transactional pool-level
statements, with a FRESH verificationId generated on every call. If
the second write failed after the first had already committed (a
dropped connection, a transient Postgres error - exactly the kind of
instability this whole project hardens against elsewhere), the
verification_results row was permanently orphaned (no matching
decision), and the async worker's retry (BullMQ attempts: 3 - see
verificationQueue.ts) would call verifyEmail() again with a brand-new
verificationId, causing a second real SMTP verification instead of a
safe retry of the same logical attempt.

This test proves the fix with real Postgres (no mocking the
database): a failure between the two writes must roll back cleanly
(no orphaned verification_results row), and a retry that reuses the
same verificationId - as the async worker now does, passing its
stable job-item id - must converge on exactly one row per table via
the ON CONFLICT (verification_id) upserts, not crash on a duplicate
key and not leave two rows behind.
*/

mock.module("./dnsCache.js", {
  namedExports: {
    getMX: async () => [{ priority: 10, exchange: "mail.example.test" }]
  }
});

mock.module("./catchAllChecker.js", {
  namedExports: {
    checkCatchAll: async () => ({
      checked: true,
      isCatchAll: false,
      confidence: "high",
      testEmail: null,
      responseCode: null,
      responseMessage: ""
    })
  }
});

mock.module("./smtpChecker.js", {
  namedExports: {
    verifySMTP: async () => ({
      success: true,
      smtpValid: true,
      mailboxExists: true,
      responseCode: 250,
      responseMessage: "OK",
      transcript: [],
      mxHost: "mail.example.test",
      durationMs: 5
    })
  }
});

/*
Static import (resolves before the mock.module() call below runs, per
node:test's module-mock semantics) captures the REAL implementation,
so the mocked version below can selectively fail once and then
delegate to genuine Postgres writes on retry - exercising the actual
transaction/rollback/upsert code path, not a fully fake one.
*/
import {
  createVerificationDecision as realCreateVerificationDecision,
  findVerificationDecisionByVerificationId as realFindVerificationDecisionByVerificationId
} from "../repositories/verificationDecisionRepository.js";

const FAILING_VERIFICATION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
let decisionCallCountForFailingId = 0;

mock.module("../repositories/verificationDecisionRepository.js", {
  namedExports: {
    createVerificationDecision: async (
      input: Parameters<typeof realCreateVerificationDecision>[0],
      executor: Parameters<typeof realCreateVerificationDecision>[1]
    ) => {
      if (input.verificationId === FAILING_VERIFICATION_ID) {
        decisionCallCountForFailingId += 1;

        if (decisionCallCountForFailingId === 1) {
          throw new Error(
            "simulated transient Postgres failure between verification_results and verification_decisions writes"
          );
        }
      }

      // Forwards the executor (the transaction's checked-out client)
      // through unchanged - dropping it would make this write run on
      // a different pooled connection than verificationRepository.save()'s,
      // outside the real transaction under test.
      return realCreateVerificationDecision(input, executor);
    },
    findVerificationDecisionByVerificationId:
      realFindVerificationDecisionByVerificationId
  }
});

const { verifyEmail } = await import("./emailVerificationOrchestrator.js");
const { VerificationRepository } = await import(
  "../repositories/verificationRepository.js"
);
const { findVerificationDecisionByVerificationId } = await import(
  "../repositories/verificationDecisionRepository.js"
);

import { requirePostgres } from "../testHelpers/requireInfra.js";

test.before(() => requirePostgres());

test("emailVerificationOrchestrator: a failure between the results and decision writes rolls back cleanly (no orphaned verification_results row)", async () => {
  const verificationRepository = new VerificationRepository();

  await assert.rejects(
    () =>
      verifyEmail("orphan-check@transaction-regression-test.example", {
        verificationId: FAILING_VERIFICATION_ID
      }),
    /simulated transient Postgres failure/
  );

  const orphanedResult = await verificationRepository.findByVerificationId(
    FAILING_VERIFICATION_ID
  );

  assert.equal(
    orphanedResult,
    null,
    "a failed decision write must roll back the already-executed verification_results write too - no orphaned row"
  );

  const orphanedDecision = await findVerificationDecisionByVerificationId(
    FAILING_VERIFICATION_ID
  );

  assert.equal(orphanedDecision, null);
});

test("emailVerificationOrchestrator: a retry with the same verificationId (BullMQ redelivery) converges on exactly one row per table instead of erroring or duplicating", async () => {
  const verificationRepository = new VerificationRepository();

  // decisionCallCountForFailingId is already 1 from the prior test
  // (the failed first attempt) - this call is attempt #2, the "retry"
  // the async worker performs by calling verifyEmail() again with the
  // SAME verificationId (job.data.itemId) after BullMQ redelivers the
  // job.
  const result = await verifyEmail(
    "orphan-check@transaction-regression-test.example",
    { verificationId: FAILING_VERIFICATION_ID }
  );

  assert.equal(result.verificationId, FAILING_VERIFICATION_ID);
  assert.equal(result.success, true);

  const persistedResult = await verificationRepository.findByVerificationId(
    FAILING_VERIFICATION_ID
  );

  assert.ok(
    persistedResult,
    "the retry must successfully persist verification_results"
  );

  const persistedDecision = await findVerificationDecisionByVerificationId(
    FAILING_VERIFICATION_ID
  );

  assert.ok(
    persistedDecision,
    "the retry must successfully persist verification_decisions - no duplicate-key crash from reusing the same verificationId"
  );

  // Confirm there is exactly one row in each table for this
  // verificationId (the upsert converged, it did not insert a second
  // row alongside the first).
  const db = (await import("../database/database.js")).default;

  const resultRowCount = await db.query(
    "SELECT COUNT(*)::int AS count FROM verification_results WHERE verification_id = $1",
    [FAILING_VERIFICATION_ID]
  );

  assert.equal(resultRowCount.rows[0].count, 1);

  const decisionRowCount = await db.query(
    "SELECT COUNT(*)::int AS count FROM verification_decisions WHERE verification_id = $1",
    [FAILING_VERIFICATION_ID]
  );

  assert.equal(decisionRowCount.rows[0].count, 1);
});

test.after(async () => {
  const db = (await import("../database/database.js")).default;

  await db.query("DELETE FROM verification_decisions WHERE verification_id = $1", [
    FAILING_VERIFICATION_ID
  ]);
  await db.query("DELETE FROM verification_results WHERE verification_id = $1", [
    FAILING_VERIFICATION_ID
  ]);

  const { closeDatabase } = await import("../database/database.js");
  await closeDatabase();
});
