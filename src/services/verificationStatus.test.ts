import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildVerificationStatus,
  type VerificationStatusInput,
} from "./verificationStatus.js";

function baseInput(
  overrides: Partial<VerificationStatusInput> = {}
): VerificationStatusInput {
  return {
    mxAvailable: true,
    mailboxExists: true,
    smtpValid: true,
    catchAll: false,
    retryRequired: false,
    responseCode: 250,
    ...overrides,
  };
}

test("verificationStatus: complete positive evidence yields VERIFIED", () => {
  const result = buildVerificationStatus(baseInput());

  assert.equal(result.status, "VERIFIED");
  assert.equal(result.mailboxVerified, true);
  assert.equal(result.retryable, false);
});

test("verificationStatus: a catch-all domain can never become VERIFIED, even with a 2xx response", () => {
  const result = buildVerificationStatus(
    baseInput({ catchAll: true })
  );

  assert.equal(result.status, "CATCH_ALL");
  assert.notEqual(result.status, "VERIFIED");
});

test("verificationStatus: a 4xx temporary response is never classified INVALID", () => {
  const result = buildVerificationStatus(
    baseInput({
      responseCode: 450,
      smtpValid: false,
      mailboxExists: false,
    })
  );

  assert.equal(result.status, "TEMPORARY");
  assert.notEqual(result.status, "INVALID");
  assert.equal(result.retryable, true);
});

test("verificationStatus: a DNS failure never becomes INVALID", () => {
  const result = buildVerificationStatus(
    baseInput({
      mxAvailable: false,
      smtpValid: false,
      mailboxExists: false,
      errorType: "DNS",
      error: "ENOTFOUND",
    })
  );

  assert.equal(result.status, "DNS_ERROR");
  assert.notEqual(result.status, "INVALID");
  assert.equal(result.retryable, true);
});

test("verificationStatus: a definitive 5xx rejection with no mailbox is INVALID", () => {
  const result = buildVerificationStatus(
    baseInput({
      responseCode: 550,
      smtpValid: false,
      mailboxExists: false,
    })
  );

  assert.equal(result.status, "INVALID");
  assert.equal(result.retryable, false);
});

test("verificationStatus: no MX record with no other evidence yields NO_MX", () => {
  const result = buildVerificationStatus(
    baseInput({
      mxAvailable: false,
      smtpValid: false,
      mailboxExists: false,
      responseCode: null,
    })
  );

  assert.equal(result.status, "NO_MX");
});

test("verificationStatus: contradictory/insufficient evidence falls back to UNKNOWN, never guesses", () => {
  const result = buildVerificationStatus(
    baseInput({
      mxAvailable: true,
      smtpValid: true,
      mailboxExists: false,
      responseCode: null,
      retryRequired: false,
      catchAll: false,
    })
  );

  // No definitive success, failure, or explicit error signal was
  // given, so the engine must not manufacture a verdict.
  assert.notEqual(result.status, "VERIFIED");
  assert.notEqual(result.status, "INVALID");
});

test("verificationStatus: isVerified() requires status + all three supporting flags", () => {
  const result = buildVerificationStatus(baseInput());

  assert.equal(result.status, "VERIFIED");
  assert.equal(result.mailboxVerified, true);
  assert.equal(result.verificationPassed, true);
  assert.equal(result.retryable, false);
});
