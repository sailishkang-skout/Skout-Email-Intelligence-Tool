/*
==================================================
OUTBOUND SEND GUARD
==================================================

Purpose
-------

This is the final safety boundary immediately
before outbound email sending.

It does NOT send email.

It does NOT perform verification.

It does NOT perform DNS or SMTP checks.

It delegates the policy decision to:

    sendEligibility.ts

The outbound mail transport must call this guard
before accepting a send request.

==================================================
SAFETY GUARANTEE
==================================================

If:

    allowed !== true

the caller must not send the email.

The guard is intentionally fail-closed.

==================================================
ARCHITECTURE
==================================================

Verification Engine
        ↓
VerificationStatusResult
        ↓
Authoritative Verification Record
        ↓
Send Eligibility
        ↓
Outbound Send Guard
        ↓
Outbound Email Service
        ↓
EmailSendProvider
        ↓
SMTP / SES / Resend / SendGrid / Mock

==================================================
IMPORTANT
==================================================

The `confidence` field exposed by this guard is
the POLICY DECISION CONFIDENCE.

It is intentionally mapped from:

    SendEligibilityResult.decisionConfidence

It MUST NOT be interpreted as:

    mailbox confidence
    deliverability confidence
    SMTP confidence
    probability that the email exists

The policy engine is deterministic, therefore
definitive policy decisions currently use 100.
==================================================
*/

import {
  evaluateSendEligibility,
  type SendEligibilityInput,
  type SendEligibilityResult,
} from "./sendEligibility.js";

/*
==================================================
VERSION
==================================================
*/

export const OUTBOUND_SEND_GUARD_VERSION =
  "1.1.0";

/*
==================================================
RESULT
==================================================
*/

export interface OutboundSendGuardResult {
  /*
  Final authorization decision.

  ONLY true permits the caller to continue toward
  the provider.
  */
  allowed: boolean;

  /*
  Convenience inverse of allowed.
  */
  blocked: boolean;

  /*
  Normalized outbound decision.
  */
  decision: SendEligibilityResult["decision"];

  /*
  Machine-readable policy reason.
  */
  reasonCode: SendEligibilityResult["reasonCode"];

  /*
  Human-readable policy explanation.
  */
  reason: string;

  /*
  IMPORTANT:

  This is policy decision confidence.

  It maps directly from:

      decisionConfidence

  in SendEligibilityResult.
  */
  confidence: number;

  /*
  Canonical verification status.
  */
  verificationStatus:
    SendEligibilityResult["verificationStatus"];

  /*
  Whether verification should be retried.
  */
  retryable: boolean;

  /*
  Whether the result requires manual review.
  */
  manualReviewRequired: boolean;

  /*
  Verification record identifier.

  This is useful for logging, audit trails and
  provider/send correlation.
  */
  verificationId: string | null;

  /*
  Policy version that produced the decision.
  */
  policyVersion: string;
}

/*
==================================================
GUARD ERROR
==================================================

A dedicated error class allows the transport,
API layer, worker or controller to distinguish:

    blocked by email policy

from:

    network failure
    provider failure
    application failure
==================================================
*/

export class OutboundSendBlockedError
  extends Error {

  public readonly code =
    "OUTBOUND_EMAIL_BLOCKED" as const;

  public readonly reasonCode:
    SendEligibilityResult["reasonCode"];

  public readonly decision:
    SendEligibilityResult["decision"];

  public readonly verificationStatus:
    SendEligibilityResult["verificationStatus"];

  public readonly confidence: number;

  public readonly retryable: boolean;

  public readonly manualReviewRequired: boolean;

  public readonly verificationId:
    string | null;

  public readonly policyVersion:
    string;

  constructor(
    result: SendEligibilityResult
  ) {

    super(
      `Outbound email blocked: ${result.reasonCode} - ${result.reason}`
    );

    this.name =
      "OutboundSendBlockedError";

    this.reasonCode =
      result.reasonCode;

    this.decision =
      result.decision;

    this.verificationStatus =
      result.verificationStatus;

    /*
    IMPORTANT:

    SendEligibilityResult calls this field:

        decisionConfidence

    The guard intentionally exposes the shorter
    compatibility field:

        confidence
    */
    this.confidence =
      result.decisionConfidence;

    this.retryable =
      result.retryable;

    this.manualReviewRequired =
      result.manualReviewRequired;

    this.verificationId =
      result.verificationId;

    this.policyVersion =
      result.policyVersion;

    /*
    Required when targeting older JavaScript
    runtimes with subclassed Error.
    */

    Object.setPrototypeOf(
      this,
      OutboundSendBlockedError.prototype
    );
  }
}

/*
==================================================
ERROR TYPE GUARD
==================================================
*/

export function isOutboundSendBlockedError(
  error: unknown
): error is OutboundSendBlockedError {

  return (
    error instanceof
    OutboundSendBlockedError
  );
}

/*
==================================================
GUARD EVALUATION
==================================================
*/

export function checkOutboundSendEligibility(
  input: SendEligibilityInput
): OutboundSendGuardResult {

  /*
  Delegate all policy logic to the canonical
  eligibility engine.

  This guard must NOT duplicate verification
  policy logic.
  */

  const eligibility =
    evaluateSendEligibility(
      input
    );

  return {
    allowed:
      eligibility.allowed,

    blocked:
      !eligibility.allowed,

    decision:
      eligibility.decision,

    reasonCode:
      eligibility.reasonCode,

    reason:
      eligibility.reason,

    /*
    Compatibility mapping:

        decisionConfidence
                ↓
            confidence
    */
    confidence:
      eligibility.decisionConfidence,

    verificationStatus:
      eligibility.verificationStatus,

    retryable:
      eligibility.retryable,

    manualReviewRequired:
      eligibility.manualReviewRequired,

    verificationId:
      eligibility.verificationId,

    policyVersion:
      eligibility.policyVersion,
  };
}

/*
==================================================
ASSERT SEND ALLOWED
==================================================

Use this immediately before the actual provider
send call.

Example:

    assertOutboundSendAllowed({
      verification
    });

    await provider.send(...);

If the assertion throws, the provider must never
be called.

==================================================
SAFETY RULE
==================================================

The caller MUST NOT catch this error and continue
to the provider.

Correct:

    assertOutboundSendAllowed(input);

    await provider.send(request);

Incorrect:

    try {
      assertOutboundSendAllowed(input);
    } catch {
      // ignore
    }

    await provider.send(request);

==================================================
*/

export function assertOutboundSendAllowed(
  input: SendEligibilityInput
): void {

  const result =
    checkOutboundSendEligibility(
      input
    );

  if (
    result.allowed !== true
  ) {
    throw new OutboundSendBlockedError(
      {
        allowed:
          result.allowed,

        decision:
          result.decision,

        reasonCode:
          result.reasonCode,

        reason:
          result.reason,

        decisionConfidence:
          result.confidence,

        verificationStatus:
          result.verificationStatus,

        retryable:
          result.retryable,

        manualReviewRequired:
          result.manualReviewRequired,

        policyVersion:
          result.policyVersion,

        verificationId:
          result.verificationId,
      }
    );
  }
}

/*
==================================================
SAFE BOOLEAN CHECK
==================================================
*/

export function isOutboundSendAllowed(
  input: SendEligibilityInput
): boolean {

  return checkOutboundSendEligibility(
    input
  ).allowed;
}

/*
==================================================
BOOLEAN ALIAS
==================================================

Convenience name for callers that want an explicit
"can send" semantic.
==================================================
*/

export function canOutboundEmailBeSent(
  verification:
    SendEligibilityInput["verification"],
  now?: Date | string | number
): boolean {

  return checkOutboundSendEligibility({
    verification,
    now,
  }).allowed;
}

/*
==================================================
COMPATIBILITY CHECK
==================================================

Explicitly named helper for callers that already
have a verification record.

==================================================
*/

export function checkOutboundEmailEligibility(
  verification:
    SendEligibilityInput["verification"],
  now?: Date | string | number
): OutboundSendGuardResult {

  return checkOutboundSendEligibility({
    verification,
    now,
  });
}

/*
==================================================
DEFAULT EXPORT
==================================================
*/

export default {
  checkOutboundSendEligibility,

  checkOutboundEmailEligibility,

  assertOutboundSendAllowed,

  isOutboundSendAllowed,

  canOutboundEmailBeSent,

  isOutboundSendBlockedError,
};