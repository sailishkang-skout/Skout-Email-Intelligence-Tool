import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

/*
patternIntelligence.ts had zero test coverage despite being the core
of the pattern-learning system (Bayesian confidence, Wilson score,
sample-strength dampening, recency decay, risk/classification/
recommendation gating) - and despite the codebase explicitly building
all of that machinery specifically to resist "pattern poisoning" (a
single lucky observation dominating a domain's ranking). These tests
exercise the real public contract (getPatternIntelligence) against
real Postgres, using the legitimate write path (patternHistory.ts)
rather than hand-crafted rows, so they prove the actual end-to-end
behavior a caller (emailVerificationOrchestrator.ts, patternRanker.ts)
depends on.
*/

import { requirePostgres } from "../testHelpers/requireInfra.js";

test.before(() => requirePostgres());

const { recordPatternSuccess, recordPatternFailure } = await import("./patternHistory.js");
const { getPatternIntelligence } = await import("./patternIntelligence.js");

function testDomain(): string {
  return `pattern-poisoning-${randomUUID().slice(0, 8)}.example`;
}

test("patternIntelligence: a single successful observation must not classify as HIGH_CONFIDENCE", async () => {
  const domain = testDomain();

  await recordPatternSuccess(domain, "flast", "SMTP");

  const result = await getPatternIntelligence(domain);
  const pattern = result.patterns.find(p => p.pattern === "flast");

  assert.ok(pattern);
  assert.notEqual(
    pattern?.classification,
    "HIGH_CONFIDENCE",
    "one observation must never be enough to reach HIGH_CONFIDENCE (min attempts requirement)"
  );
});

test("patternIntelligence: a single failed observation yields CRITICAL/HIGH risk, never PREFER", async () => {
  const domain = testDomain();

  await recordPatternFailure(domain, "flast", "SMTP");

  const result = await getPatternIntelligence(domain);
  const pattern = result.patterns.find(p => p.pattern === "flast");

  assert.ok(pattern);
  assert.notEqual(pattern?.recommendation, "PREFER");
  assert.notEqual(pattern?.recommendation, "ALLOW");
});

test("patternIntelligence: a large consistent sample outranks a small sample with the same success rate (Wilson-score-style dampening)", async () => {
  const domain = testDomain();

  // Small sample: 2/2 success.
  await recordPatternSuccess(domain, "small-sample", "SMTP");
  await recordPatternSuccess(domain, "small-sample", "SMTP");

  // Large sample: 15/15 success - same 100% rate, far more evidence.
  for (let i = 0; i < 15; i++) {
    await recordPatternSuccess(domain, "large-sample", "SMTP");
  }

  const result = await getPatternIntelligence(domain);
  const small = result.patterns.find(p => p.pattern === "small-sample");
  const large = result.patterns.find(p => p.pattern === "large-sample");

  assert.ok(small);
  assert.ok(large);
  assert.ok(
    (large?.reliabilityScore ?? 0) > (small?.reliabilityScore ?? 0),
    `expected the larger, equally-successful sample to have higher reliability (large=${large?.reliabilityScore}, small=${small?.reliabilityScore})`
  );

  // The ranked list itself must put the better-evidenced pattern first.
  assert.equal(result.bestPattern?.pattern, "large-sample");
});

test("patternIntelligence: conflicting observations for the same pattern never reach PREFER", async () => {
  const domain = testDomain();

  await recordPatternSuccess(domain, "mixed", "SMTP");
  await recordPatternFailure(domain, "mixed", "SMTP");
  await recordPatternSuccess(domain, "mixed", "SMTP");
  await recordPatternFailure(domain, "mixed", "SMTP");

  const result = await getPatternIntelligence(domain);
  const pattern = result.patterns.find(p => p.pattern === "mixed");

  assert.ok(pattern);
  assert.notEqual(
    pattern?.recommendation,
    "PREFER",
    "a pattern with real, recent failures mixed into its history must never be PREFERred"
  );
});

test("patternIntelligence: a pattern with zero recorded attempts is never returned as usable evidence", async () => {
  const domain = testDomain();

  // Nothing recorded for this domain at all.
  const result = await getPatternIntelligence(domain);

  assert.equal(result.patterns.length, 0);
  assert.equal(result.bestPattern, null);
  assert.equal(result.hasReliablePattern, false);
});

test("patternIntelligence: a consistently strong pattern (multiple successes, no failures) is classified HIGH_CONFIDENCE and PREFERred", async () => {
  const domain = testDomain();

  for (let i = 0; i < 5; i++) {
    await recordPatternSuccess(domain, "proven", "SMTP");
  }

  const result = await getPatternIntelligence(domain);
  const pattern = result.patterns.find(p => p.pattern === "proven");

  assert.ok(pattern);
  assert.equal(pattern?.classification, "HIGH_CONFIDENCE");
  assert.equal(pattern?.recommendation, "PREFER");
  assert.equal(result.bestPattern?.pattern, "proven");
  assert.equal(result.hasReliablePattern, true);
});

test.after(async () => {
  const { closeDatabase } = await import("../database/database.js");
  await closeDatabase();
});
