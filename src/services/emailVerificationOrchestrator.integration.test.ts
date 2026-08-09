import { test, mock } from "node:test";
import assert from "node:assert/strict";

/*
Regression test for a real production bug: verifyEmail() persisted a
DIFFERENT verification_status to Postgres than the one it returned to
the caller / the live API. Root cause was a second, drifted copy of
buildVerificationStatus (src/types/verificationStatus.ts, since
deleted) used only for persistence, which lacked the canonical
engine's "SMTP failed with no response code" fallback rule and fell
back to UNKNOWN instead of SMTP_ERROR. Reproduced live against
postmaster@apple.com (blocked by a Spamhaus IP listing during the
SMTP greeting) — the API returned verificationStatus.status ===
"SMTP_ERROR" while Postgres stored "UNKNOWN" for the same
verificationId.

This test reproduces the same class of failure deterministically (an
SMTP verifier that fails before any response code is available) by
mocking the network-facing collaborators, then asserts the persisted
rows agree with the returned result — instead of depending on a
specific third-party mail server's blocklist status.
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
      success: false,
      smtpValid: false,
      mailboxExists: false,
      responseCode: null,
      responseMessage: "SMTP greeting failed: mocked blocklist rejection",
      transcript: [],
      mxHost: "mail.example.test",
      durationMs: 5
    })
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

test("emailVerificationOrchestrator: a mid-transaction SMTP failure persists the SAME verification_status it returns, not UNKNOWN", async () => {
  const result = await verifyEmail(
    "postmaster@smtp-error-regression-test.example"
  );

  assert.equal(result.verificationStatus.status, "SMTP_ERROR");

  const verificationRepository = new VerificationRepository();

  const persistedResult = await verificationRepository.findByVerificationId(
    result.verificationId
  );

  assert.ok(persistedResult, "expected a persisted verification_results row");
  assert.equal(
    persistedResult?.verification_status,
    "SMTP_ERROR",
    "verification_results.verification_status must match the returned status, not fall back to UNKNOWN"
  );

  const persistedDecision = await findVerificationDecisionByVerificationId(
    result.verificationId
  );

  assert.ok(persistedDecision, "expected a persisted verification_decisions row");
  assert.equal(
    persistedDecision?.verificationStatus,
    "SMTP_ERROR",
    "verification_decisions.verification_status must match the returned status, not fall back to UNKNOWN"
  );
});

test.after(async () => {
  const { closeDatabase } = await import("../database/database.js");
  await closeDatabase();
});
