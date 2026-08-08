import { test } from "node:test";
import assert from "node:assert/strict";

import {
  checkOutboundSendEligibility,
  assertOutboundSendAllowed,
  isOutboundSendBlockedError,
  OutboundSendBlockedError,
} from "./outboundSendGuard.js";

import { createAuthoritativeVerificationRecord } from "./sendEligibility.js";

function verifiedRecord() {
  return createAuthoritativeVerificationRecord(
    {
      status: "VERIFIED",
      mailboxVerified: true,
      verificationPassed: true,
      retryable: false,
      reasonCode: "MAILBOX_VERIFIED",
      reason: "test",
      statusEngineVersion: "1.0.0",
    },
    {
      verificationId: "verification-guard-1",
      emailAddress: "person@example.com",
    }
  );
}

function invalidRecord() {
  return createAuthoritativeVerificationRecord(
    {
      status: "INVALID",
      mailboxVerified: false,
      verificationPassed: false,
      retryable: false,
      reasonCode: "MAILBOX_REJECTED",
      reason: "test",
      statusEngineVersion: "1.0.0",
    },
    {
      verificationId: "verification-guard-2",
      emailAddress: "person@example.com",
    }
  );
}

test("outboundSendGuard: allows a verified record through", () => {
  const result = checkOutboundSendEligibility({
    verification: verifiedRecord(),
  });

  assert.equal(result.allowed, true);
  assert.equal(result.blocked, false);
});

test("outboundSendGuard: blocks an invalid record", () => {
  const result = checkOutboundSendEligibility({
    verification: invalidRecord(),
  });

  assert.equal(result.allowed, false);
  assert.equal(result.blocked, true);
});

test("outboundSendGuard: assertOutboundSendAllowed throws OutboundSendBlockedError when not allowed", () => {
  assert.throws(
    () => {
      assertOutboundSendAllowed({
        verification: invalidRecord(),
      });
    },
    (error: unknown) => {
      assert.ok(isOutboundSendBlockedError(error));
      assert.ok(error instanceof OutboundSendBlockedError);
      return true;
    }
  );
});

test("outboundSendGuard: assertOutboundSendAllowed does not throw when allowed", () => {
  assert.doesNotThrow(() => {
    assertOutboundSendAllowed({
      verification: verifiedRecord(),
    });
  });
});

test("outboundSendGuard: isOutboundSendBlockedError returns false for unrelated errors", () => {
  assert.equal(
    isOutboundSendBlockedError(new Error("unrelated")),
    false
  );
});
