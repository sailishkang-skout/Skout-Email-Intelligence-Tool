import { test } from "node:test";
import assert from "node:assert/strict";

import {
  calculateEvidenceConfidence,
  type ConfidenceEvidenceInput,
} from "./confidenceEngine.js";

function baseInput(
  overrides: Partial<ConfidenceEvidenceInput> = {}
): ConfidenceEvidenceInput {
  return {
    mxAvailable: true,
    smtpValid: true,
    mailboxExists: true,
    responseCode: 250,
    catchAll: false,
    retryRequired: false,
    providerDetected: false,
    ...overrides,
  };
}

test("confidenceEngine: score is always bounded between 0 and 100", () => {
  const strong = calculateEvidenceConfidence(baseInput());
  const weak = calculateEvidenceConfidence(
    baseInput({
      mxAvailable: false,
      smtpValid: false,
      mailboxExists: false,
      responseCode: null,
    })
  );

  assert.ok(strong.score >= 0 && strong.score <= 100);
  assert.ok(weak.score >= 0 && weak.score <= 100);
});

test("confidenceEngine: strong mailbox evidence yields VERIFIED status and high score", () => {
  const result = calculateEvidenceConfidence(baseInput());

  assert.equal(result.status, "VERIFIED");
  assert.ok(result.score >= 80);
});

test("confidenceEngine: catch-all domains are hard-capped regardless of other signals", () => {
  const result = calculateEvidenceConfidence(
    baseInput({
      catchAll: true,
      catchAllConfidence: "high",
    })
  );

  assert.equal(result.status, "CATCH_ALL");
  assert.ok(
    result.score <= 59,
    `expected catch-all (high confidence) score to be capped at 59, got ${result.score}`
  );
});

test("confidenceEngine: catch-all cap loosens with lower catch-all confidence but never disappears", () => {
  const high = calculateEvidenceConfidence(
    baseInput({ catchAll: true, catchAllConfidence: "high" })
  );
  const low = calculateEvidenceConfidence(
    baseInput({ catchAll: true, catchAllConfidence: "low" })
  );

  assert.ok(low.score >= high.score);
  assert.ok(low.score <= 69);
});

test("confidenceEngine: a definitive SMTP 5xx rejection forces a high-confidence INVALID classification", () => {
  const result = calculateEvidenceConfidence(
    baseInput({
      smtpValid: false,
      mailboxExists: false,
      responseCode: 550,
    })
  );

  assert.equal(result.status, "INVALID");
  assert.equal(result.score, 95);
});

test("confidenceEngine: retryRequired combined with unresolved mailbox yields TEMPORARY_FAILURE", () => {
  const result = calculateEvidenceConfidence(
    baseInput({
      smtpValid: false,
      mailboxExists: false,
      responseCode: null,
      retryRequired: true,
    })
  );

  assert.equal(result.status, "TEMPORARY_FAILURE");
});

test("confidenceEngine: pattern intelligence evidence cannot override a hard SMTP 5xx rejection", () => {
  const result = calculateEvidenceConfidence(
    baseInput({
      smtpValid: false,
      mailboxExists: false,
      responseCode: 550,
      patternReliabilityScore: 100,
      patternBayesianConfidence: 100,
      patternWilsonScore: 100,
      patternStabilityScore: 100,
      patternTrend: "IMPROVING",
    })
  );

  assert.equal(result.status, "INVALID");
  assert.equal(result.score, 95);
});

test("confidenceEngine: score is deterministic for identical inputs", () => {
  const input = baseInput({ patternConfidence: 0.8, patternAttempts: 10 });

  const first = calculateEvidenceConfidence(input);
  const second = calculateEvidenceConfidence(input);

  assert.deepEqual(first, second);
});

test("confidenceEngine: level thresholds are monotonic with score", () => {
  const veryHigh = calculateEvidenceConfidence(baseInput());
  const veryLow = calculateEvidenceConfidence(
    baseInput({
      mxAvailable: false,
      smtpValid: false,
      mailboxExists: false,
      responseCode: null,
      retryRequired: true,
    })
  );

  assert.equal(veryHigh.level, "VERY_HIGH");
  assert.equal(veryLow.level, "VERY_LOW");
});
