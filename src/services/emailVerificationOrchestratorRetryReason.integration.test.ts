import { test, mock } from "node:test";
import assert from "node:assert/strict";

/*
Regression test for a real, confirmed bug: VerifyEmailResult's
top-level `retryReason` field (distinct from the nested
`result.smtp.retryReason`) was hardcoded to null in the orchestrator's
return statement, regardless of the actual SMTP result. routes/verify.ts
builds its own response from `result.retryReason` (the top-level
field, not the nested one) - so callers of POST /verify always saw
retryReason: null, even for a genuinely retryable failure with a real
reason available one level down.
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
      responseCode: 450,
      responseMessage: "Temporary local problem, please try again later",
      retryRequired: true,
      retryReason: "SMTP greylisting detected - temporary rejection",
      transcript: [],
      mxHost: "mail.example.test",
      durationMs: 5
    })
  }
});

const { verifyEmail } = await import("./emailVerificationOrchestrator.js");

import { requirePostgres } from "../testHelpers/requireInfra.js";

test.before(() => requirePostgres());

test("emailVerificationOrchestrator: the top-level retryReason reflects the real SMTP retry reason, not a hardcoded null", async () => {
  const result = await verifyEmail("retry-reason-regression@example.test");

  assert.equal(result.retryRequired, true);
  assert.equal(
    result.retryReason,
    "SMTP greylisting detected - temporary rejection",
    "the top-level retryReason (what routes/verify.ts actually returns to callers) must reflect the real reason, not be hardcoded null"
  );
  assert.equal(result.retryReason, result.smtp.retryReason);
});

test.after(async () => {
  const { closeDatabase } = await import("../database/database.js");
  await closeDatabase();
});
