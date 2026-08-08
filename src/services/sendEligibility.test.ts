import { test } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateSendEligibility,
  createAuthoritativeVerificationRecord,
  type AuthoritativeVerificationRecord,
} from "./sendEligibility.js";

import type { VerificationStatusResult } from "./verificationStatus.js";

function statusResult(
  overrides: Partial<VerificationStatusResult> = {}
): VerificationStatusResult {
  return {
    status: "VERIFIED",
    mailboxVerified: true,
    verificationPassed: true,
    retryable: false,
    reasonCode: "MAILBOX_VERIFIED",
    reason: "test",
    statusEngineVersion: "1.0.0",
    ...overrides,
  };
}

function authoritativeRecord(
  overrides: Partial<AuthoritativeVerificationRecord> = {}
): AuthoritativeVerificationRecord {
  return createAuthoritativeVerificationRecord(statusResult(), {
    verificationId: "verification-1",
    emailAddress: "person@example.com",
    verifiedAt: new Date().toISOString(),
    expiresAt: null,
    verifierVersion: "test-engine",
    ...overrides,
  });
}

test("sendEligibility: a fully verified, fresh, authoritative record is allowed", () => {
  const result = evaluateSendEligibility({
    verification: authoritativeRecord(),
  });

  assert.equal(result.allowed, true);
  assert.equal(result.decision, "USE_EMAIL");
});

test("sendEligibility: CRITICAL — a record that is not marked authoritative is always blocked", () => {
  const record = authoritativeRecord();

  const result = evaluateSendEligibility({
    verification: {
      ...record,
      authoritative: false,
    },
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reasonCode, "VERIFICATION_NOT_AUTHORITATIVE");
});

test("sendEligibility: CRITICAL — a malformed/spoofed record fails closed", () => {
  const result = evaluateSendEligibility({
    // @ts-expect-error intentionally malformed input
    verification: {
      authoritative: true,
      status: "VERIFIED",
    },
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reasonCode, "INVALID_POLICY_INPUT");
});

test("sendEligibility: INVALID mailbox status is never allowed", () => {
  const record = createAuthoritativeVerificationRecord(
    statusResult({
      status: "INVALID",
      mailboxVerified: false,
      verificationPassed: false,
    }),
    {
      verificationId: "verification-2",
      emailAddress: "person@example.com",
    }
  );

  const result = evaluateSendEligibility({ verification: record });

  assert.equal(result.allowed, false);
  assert.equal(result.decision, "DO_NOT_USE");
});

test("sendEligibility: CATCH_ALL status requires manual review, never allowed", () => {
  const record = createAuthoritativeVerificationRecord(
    statusResult({
      status: "CATCH_ALL",
      mailboxVerified: false,
      verificationPassed: false,
    }),
    {
      verificationId: "verification-3",
      emailAddress: "person@example.com",
    }
  );

  const result = evaluateSendEligibility({ verification: record });

  assert.equal(result.allowed, false);
  assert.equal(result.manualReviewRequired, true);
});

test("sendEligibility: an expired verification is blocked and marked retryable", () => {
  const now = new Date();
  const verifiedAt = new Date(now.getTime() - 60_000).toISOString();
  const expiresAt = new Date(now.getTime() - 1_000).toISOString();

  const record = createAuthoritativeVerificationRecord(statusResult(), {
    verificationId: "verification-4",
    emailAddress: "person@example.com",
    verifiedAt,
    expiresAt,
  });

  const result = evaluateSendEligibility({
    verification: record,
    now,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reasonCode, "VERIFICATION_EXPIRED");
  assert.equal(result.retryable, true);
});

test("sendEligibility: a VERIFIED status with inconsistent supporting evidence is blocked", () => {
  const record = createAuthoritativeVerificationRecord(
    statusResult({
      status: "VERIFIED",
      mailboxVerified: false, // inconsistent with VERIFIED status
    }),
    {
      verificationId: "verification-5",
      emailAddress: "person@example.com",
    }
  );

  const result = evaluateSendEligibility({ verification: record });

  assert.equal(result.allowed, false);
  assert.equal(result.reasonCode, "STATUS_NOT_VERIFIED");
});

test("sendEligibility: TEMPORARY status is retryable, not allowed", () => {
  const record = createAuthoritativeVerificationRecord(
    statusResult({
      status: "TEMPORARY",
      mailboxVerified: false,
      verificationPassed: false,
      retryable: true,
    }),
    {
      verificationId: "verification-6",
      emailAddress: "person@example.com",
    }
  );

  const result = evaluateSendEligibility({ verification: record });

  assert.equal(result.allowed, false);
  assert.equal(result.decision, "RETRY_VERIFICATION");
  assert.equal(result.retryable, true);
});
