import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildVerificationDecision,
  type VerificationDecisionInput,
} from "./verificationDecisionEngine.js";

function baseInput(
  overrides: Partial<VerificationDecisionInput> = {}
): VerificationDecisionInput {
  return {
    smtpValid: true,
    mailboxExists: true,
    responseCode: 250,
    mxAvailable: true,
    catchAll: false,
    retryRequired: false,
    confidenceScore: 90,
    confidenceStatus: "VERIFIED",
    ...overrides,
  };
}

test("verificationDecisionEngine: retryRequired always wins and returns RETRY", () => {
  const result = buildVerificationDecision(
    baseInput({
      retryRequired: true,
      // Even with otherwise perfect evidence, a temporary
      // result must never be treated as definitive.
      patternRiskLevel: "CRITICAL",
    })
  );

  assert.equal(result.decision, "RETRY");
});

test("verificationDecisionEngine: no MX record blocks sending outright", () => {
  const result = buildVerificationDecision(
    baseInput({ mxAvailable: false })
  );

  assert.equal(result.decision, "DO_NOT_SEND");
});

test("verificationDecisionEngine: catch-all domains require manual review, never SAFE_TO_SEND", () => {
  const result = buildVerificationDecision(
    baseInput({ catchAll: true })
  );

  assert.equal(result.decision, "MANUAL_REVIEW");
  assert.ok(result.confidence <= 69);
});

test("verificationDecisionEngine: a permanent SMTP rejection is DO_NOT_SEND even with high confidence score", () => {
  const result = buildVerificationDecision(
    baseInput({
      smtpValid: false,
      mailboxExists: false,
      responseCode: 550,
      confidenceScore: 95,
    })
  );

  assert.equal(result.decision, "DO_NOT_SEND");
});

test("verificationDecisionEngine: strong direct evidence with high confidence is SAFE_TO_SEND", () => {
  const result = buildVerificationDecision(baseInput());

  assert.equal(result.decision, "SAFE_TO_SEND");
});

test("verificationDecisionEngine: CRITICAL pattern risk forces manual review even with strong SMTP evidence", () => {
  const result = buildVerificationDecision(
    baseInput({ patternRiskLevel: "CRITICAL" })
  );

  assert.equal(result.decision, "MANUAL_REVIEW");
});

test("verificationDecisionEngine: low confidence without other overrides is DO_NOT_SEND", () => {
  const result = buildVerificationDecision(
    baseInput({
      smtpValid: false,
      mailboxExists: false,
      responseCode: null,
      confidenceScore: 20,
    })
  );

  assert.equal(result.decision, "DO_NOT_SEND");
});

test("verificationDecisionEngine: decision is deterministic for identical inputs", () => {
  const input = baseInput();

  assert.deepEqual(
    buildVerificationDecision(input),
    buildVerificationDecision(input)
  );
});
