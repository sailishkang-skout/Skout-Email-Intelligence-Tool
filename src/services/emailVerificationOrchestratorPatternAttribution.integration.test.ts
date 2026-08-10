import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

/*
Regression test for a real, confirmed bug in the pattern-learning
loop: emailVerificationOrchestrator.ts's call to evaluatePatternEvidence()
(patternEvidence.ts) passed patternIntelligence.bestPattern?.pattern -
the domain's current highest-RANKED HISTORICAL pattern - as the
pattern to teach, instead of `pattern` (the pattern this specific
email actually represents, e.g. candidate.pattern from
emailDiscoveryEngine.ts, passed through verifyEmail()'s own
options.pattern).

Concretely, this meant: once a domain had ANY pattern history, a
definitive SMTP success/failure for a DIFFERENT pattern than the
domain's current best got silently attributed to the WRONG pattern -
poisoning the best-ranked pattern's learned statistics with an
unrelated outcome, while the pattern actually under test received no
learning credit at all. This is exactly the scenario email discovery
depends on (verifying multiple candidate patterns for the same domain
to learn which one actually works).

This test proves the fix against real Postgres: verifies two DIFFERENT
patterns for the SAME domain (both a definitive SMTP success) and
asserts each pattern's own pattern_history reflects only its own
outcome.
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

const { verifyEmail } = await import("./emailVerificationOrchestrator.js");
const { getPatternHistory } = await import("./patternHistory.js");

import { requirePostgres } from "../testHelpers/requireInfra.js";

test.before(() => requirePostgres());

test("emailVerificationOrchestrator: pattern evidence is attributed to the pattern this email actually represents, not the domain's unrelated current-best pattern", async () => {
  const domain = `pattern-attribution-${randomUUID().slice(0, 8)}.example`;

  const firstPattern = "existing-best-pattern";
  const secondPattern = "newly-tested-pattern";

  // Establish `firstPattern` as this domain's only (and therefore
  // highest-ranked) known pattern with one recorded success.
  const firstResult = await verifyEmail(`someone@${domain}`, { pattern: firstPattern });

  // Regression check for a related bug in the same area: the
  // returned patternEvidence field was a hardcoded stub
  // ({evaluated:false, recorded:false, outcome:null, reasonCode:null})
  // completely disconnected from the real evaluatePatternEvidence()
  // call - the API always claimed pattern evidence was never
  // evaluated, even when it genuinely was and got persisted.
  assert.equal(firstResult.patternEvidence.evaluated, true);
  assert.equal(firstResult.patternEvidence.recorded, true);
  assert.equal(firstResult.patternEvidence.outcome, "SUCCESS");

  const firstAfterFirstCall = await getPatternHistory(domain, firstPattern);
  assert.ok(firstAfterFirstCall, "expected pattern_history for the first pattern");
  assert.equal(firstAfterFirstCall?.successes, 1);

  // Now verify a DIFFERENT pattern for the SAME domain. Before the
  // fix, this success was silently recorded against `firstPattern`
  // (patternIntelligence.bestPattern) instead of `secondPattern`.
  await verifyEmail(`different-person@${domain}`, { pattern: secondPattern });

  const secondPatternHistory = await getPatternHistory(domain, secondPattern);
  assert.ok(
    secondPatternHistory,
    "the pattern actually verified must have its own pattern_history row"
  );
  assert.equal(
    secondPatternHistory?.successes,
    1,
    "the second verification's success must be credited to the pattern it actually verified"
  );

  const firstAfterSecondCall = await getPatternHistory(domain, firstPattern);
  assert.equal(
    firstAfterSecondCall?.successes,
    1,
    "verifying a DIFFERENT pattern for the same domain must not silently add a success to the domain's unrelated current-best pattern"
  );
});

test.after(async () => {
  const { closeDatabase } = await import("../database/database.js");
  await closeDatabase();
});
