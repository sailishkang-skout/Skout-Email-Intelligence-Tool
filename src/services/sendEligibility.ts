/*
==================================================
SEND ELIGIBILITY ENGINE
==================================================

Purpose:

    Determines whether a verified email may be used
    for outbound sending.

This service DOES NOT:

    - perform DNS
    - perform MX checks
    - perform SMTP
    - perform email verification
    - call external providers
    - send email

Architecture:

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
Email Provider

SAFETY PRINCIPLE:

ONLY:

    authoritative === true
    +
    status === VERIFIED
    +
    mailboxVerified === true
    +
    verificationPassed === true
    +
    retryable === false
    +
    verification is fresh

can produce:

    USE_EMAIL

Everything else fails closed.
==================================================
*/

import type {
  VerificationStatus,
  VerificationStatusResult,
} from "./verificationStatus.js";

export const SEND_ELIGIBILITY_POLICY_VERSION =
  "1.1.0";

/*
==================================================
DECISION
==================================================
*/

export type SendEligibilityDecision =
  | "USE_EMAIL"
  | "DO_NOT_USE"
  | "RETRY_VERIFICATION"
  | "MANUAL_REVIEW";

/*
==================================================
REASON CODES
==================================================
*/

export type SendEligibilityReasonCode =
  | "VERIFIED_MAILBOX"
  | "INVALID_MAILBOX"
  | "CATCH_ALL"
  | "TEMPORARY_VERIFICATION"
  | "NO_MX"
  | "DNS_ERROR"
  | "SMTP_ERROR"
  | "UNKNOWN_VERIFICATION"
  | "STATUS_NOT_VERIFIED"
  | "VERIFICATION_EXPIRED"
  | "VERIFICATION_NOT_YET_VALID"
  | "VERIFICATION_NOT_AUTHORITATIVE"
  | "INVALID_POLICY_INPUT";

/*
==================================================
AUTHORITATIVE VERIFICATION RECORD
==================================================

VerificationStatusResult tells us:

    "What did the verifier determine?"

AuthoritativeVerificationRecord tells us:

    "What verification result is trusted by the
     outbound sending system?"

The authoritative flag MUST be created server-side.

A client must never be allowed to manufacture:

    authoritative: true
==================================================
*/

export interface AuthoritativeVerificationRecord
  extends VerificationStatusResult {

  /*
  ------------------------------------------
  Verification identity
  ------------------------------------------
  */

  verificationId: string;

  /*
  Email address verified by this record.
  */

  emailAddress: string;

  /*
  ------------------------------------------
  Provenance
  ------------------------------------------
  */

  verifiedAt: string;

  /*
  null means no explicit expiry is configured.
  */

  expiresAt: string | null;

  /*
  Version of the verification engine that
  produced this record.
  */

  verifierVersion: string;

  /*
  True only when the record has been trusted
  by the server-side verification pipeline.
  */

  authoritative: boolean;
}

/*
==================================================
INPUT
==================================================
*/

export interface SendEligibilityInput {
  verification:
    AuthoritativeVerificationRecord;

  /*
  Injectable clock for deterministic testing.
  */

  now?: Date | string | number;
}

/*
==================================================
RESULT
==================================================
*/

export interface SendEligibilityResult {

  allowed: boolean;

  decision: SendEligibilityDecision;

  reasonCode: SendEligibilityReasonCode;

  reason: string;

  /*
  Confidence in the POLICY DECISION.

  This is deliberately named decisionConfidence
  so it cannot be confused with mailbox confidence.
  */

  decisionConfidence: number;

  verificationStatus: VerificationStatus;

  retryable: boolean;

  manualReviewRequired: boolean;

  policyVersion: string;

  verificationId: string | null;
}

/*
==================================================
CONFIDENCE CONSTANTS
==================================================

The confidence here describes confidence in the
policy decision, NOT mailbox existence.

The policy is deterministic, so definitive policy
decisions use 100.
==================================================
*/

const POLICY_CONFIDENCE = 100;

/*
==================================================
HELPERS
==================================================
*/

function normalizeDate(
  value: Date | string | number | null | undefined
): Date | null {

  if (value == null) {
    return null;
  }

  const date =
    value instanceof Date
      ? new Date(value.getTime())
      : new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return null;
  }

  return date;
}

function normalizeEmail(
  value: unknown
): string | null {

  if (
    typeof value !== "string"
  ) {
    return null;
  }

  const email =
    value.trim().toLowerCase();

  return email.length > 0
    ? email
    : null;
}

function normalizeId(
  value: unknown
): string | null {

  if (
    typeof value !== "string"
  ) {
    return null;
  }

  const id =
    value.trim();

  return id.length > 0
    ? id
    : null;
}

/*
==================================================
AUTHORITATIVE RECORD VALIDATION
==================================================
*/

function validVerificationRecord(
  value: unknown
): value is AuthoritativeVerificationRecord {

  if (
    !value ||
    typeof value !== "object"
  ) {
    return false;
  }

  const record =
    value as Partial<AuthoritativeVerificationRecord>;

  if (
    !normalizeId(
      record.verificationId
    )
  ) {
    return false;
  }

  if (
    !normalizeEmail(
      record.emailAddress
    )
  ) {
    return false;
  }

  if (
    typeof record.authoritative !== "boolean"
  ) {
    return false;
  }

  if (
    typeof record.status !== "string"
  ) {
    return false;
  }

  if (
    typeof record.mailboxVerified !== "boolean"
  ) {
    return false;
  }

  if (
    typeof record.verificationPassed !== "boolean"
  ) {
    return false;
  }

  if (
    typeof record.retryable !== "boolean"
  ) {
    return false;
  }

  if (
    typeof record.reasonCode !== "string"
  ) {
    return false;
  }

  if (
    typeof record.reason !== "string"
  ) {
    return false;
  }

  if (
    typeof record.verifiedAt !== "string" ||
    !normalizeDate(
      record.verifiedAt
    )
  ) {
    return false;
  }

  if (
    record.expiresAt !== null &&
    (
      typeof record.expiresAt !== "string" ||
      !normalizeDate(
        record.expiresAt
      )
    )
  ) {
    return false;
  }

  if (
    typeof record.verifierVersion !== "string" ||
    record.verifierVersion.trim().length === 0
  ) {
    return false;
  }

  return true;
}

/*
==================================================
RESULT FACTORY
==================================================
*/

function createResult(
  params: {
    allowed: boolean;

    decision: SendEligibilityDecision;

    reasonCode: SendEligibilityReasonCode;

    reason: string;

    decisionConfidence: number;

    verificationStatus: VerificationStatus;

    retryable: boolean;

    manualReviewRequired: boolean;

    verificationId?: string | null;
  }
): SendEligibilityResult {

  return {
    allowed:
      params.allowed,

    decision:
      params.decision,

    reasonCode:
      params.reasonCode,

    reason:
      params.reason,

    decisionConfidence:
      params.decisionConfidence,

    verificationStatus:
      params.verificationStatus,

    retryable:
      params.retryable,

    manualReviewRequired:
      params.manualReviewRequired,

    policyVersion:
      SEND_ELIGIBILITY_POLICY_VERSION,

    verificationId:
      params.verificationId ??
      null,
  };
}

/*
==================================================
FRESHNESS CHECK
==================================================
*/

function checkVerificationFreshness(
  verification: AuthoritativeVerificationRecord,
  now: Date
):
  | {
      valid: true;
    }
  | {
      valid: false;

      reasonCode:
        | "VERIFICATION_EXPIRED"
        | "VERIFICATION_NOT_YET_VALID";

      reason: string;
    } {

  const verifiedAt =
    normalizeDate(
      verification.verifiedAt
    );

  if (!verifiedAt) {
    return {
      valid: false,

      reasonCode:
        "VERIFICATION_NOT_YET_VALID",

      reason:
        "The verification timestamp is invalid, so the result cannot be trusted for sending.",
    };
  }

  if (
    verifiedAt.getTime() >
    now.getTime()
  ) {
    return {
      valid: false,

      reasonCode:
        "VERIFICATION_NOT_YET_VALID",

      reason:
        "The verification result has a future verification timestamp and cannot currently be trusted.",
    };
  }

  /*
  No expiry configured.

  This is permitted by the policy engine.

  Production persistence should normally configure
  an expiry/TTL for outbound verification.
  */

  if (
    verification.expiresAt === null
  ) {
    return {
      valid: true,
    };
  }

  const expiresAt =
    normalizeDate(
      verification.expiresAt
    );

  if (!expiresAt) {
    return {
      valid: false,

      reasonCode:
        "VERIFICATION_EXPIRED",

      reason:
        "The verification expiry timestamp is invalid, so the result cannot be trusted for sending.",
    };
  }

  if (
    now.getTime() >=
    expiresAt.getTime()
  ) {
    return {
      valid: false,

      reasonCode:
        "VERIFICATION_EXPIRED",

      reason:
        "The email verification result has expired and must be refreshed before sending.",
    };
  }

  return {
    valid: true,
  };
}

/*
==================================================
MAIN POLICY ENGINE
==================================================
*/

export function evaluateSendEligibility(
  input: SendEligibilityInput
): SendEligibilityResult {

  /*
  ==================================================
  1. INPUT VALIDATION
  ==================================================
  */

  if (
    !input ||
    typeof input !== "object" ||
    !validVerificationRecord(
      input.verification
    )
  ) {

    return createResult({

      allowed:
        false,

      decision:
        "MANUAL_REVIEW",

      reasonCode:
        "INVALID_POLICY_INPUT",

      reason:
        "The authoritative verification record is missing or invalid. Sending is blocked.",

      decisionConfidence:
        POLICY_CONFIDENCE,

      verificationStatus:
        "UNKNOWN",

      retryable:
        false,

      manualReviewRequired:
        true,

      verificationId:
        null,
    });
  }

  const verification =
    input.verification;

  /*
  ==================================================
  2. AUTHORITY CHECK
  ==================================================
  */

  if (
    verification.authoritative !== true
  ) {

    return createResult({

      allowed:
        false,

      decision:
        "MANUAL_REVIEW",

      reasonCode:
        "VERIFICATION_NOT_AUTHORITATIVE",

      reason:
        "The verification result is not marked as authoritative server-side. Sending is blocked.",

      decisionConfidence:
        POLICY_CONFIDENCE,

      verificationStatus:
        verification.status,

      retryable:
        false,

      manualReviewRequired:
        true,

      verificationId:
        verification.verificationId,
    });
  }

  /*
  ==================================================
  3. CURRENT TIME
  ==================================================
  */

  const now =
    normalizeDate(
      input.now
    ) ??
    new Date();

  /*
  ==================================================
  4. INVALID
  ==================================================
  */

  if (
    verification.status === "INVALID"
  ) {

    return createResult({

      allowed:
        false,

      decision:
        "DO_NOT_USE",

      reasonCode:
        "INVALID_MAILBOX",

      reason:
        "The mailbox was definitively rejected by the verification system and must not be used for sending.",

      decisionConfidence:
        POLICY_CONFIDENCE,

      verificationStatus:
        "INVALID",

      retryable:
        false,

      manualReviewRequired:
        false,

      verificationId:
        verification.verificationId,
    });
  }

  /*
  ==================================================
  5. CATCH-ALL
  ==================================================
  */

  if (
    verification.status === "CATCH_ALL"
  ) {

    return createResult({

      allowed:
        false,

      decision:
        "MANUAL_REVIEW",

      reasonCode:
        "CATCH_ALL",

      reason:
        "The domain accepts arbitrary recipients, so mailbox-specific existence cannot be confirmed. Sending is blocked pending review.",

      decisionConfidence:
        POLICY_CONFIDENCE,

      verificationStatus:
        "CATCH_ALL",

      retryable:
        false,

      manualReviewRequired:
        true,

      verificationId:
        verification.verificationId,
    });
  }

  /*
  ==================================================
  6. TEMPORARY
  ==================================================
  */

  if (
    verification.status === "TEMPORARY"
  ) {

    return createResult({

      allowed:
        false,

      decision:
        "RETRY_VERIFICATION",

      reasonCode:
        "TEMPORARY_VERIFICATION",

      reason:
        "Verification returned a temporary result. The email must be re-verified before sending.",

      decisionConfidence:
        POLICY_CONFIDENCE,

      verificationStatus:
        "TEMPORARY",

      retryable:
        true,

      manualReviewRequired:
        false,

      verificationId:
        verification.verificationId,
    });
  }

  /*
  ==================================================
  7. NO MX
  ==================================================
  */

  if (
    verification.status === "NO_MX"
  ) {

    return createResult({

      allowed:
        false,

      decision:
        "DO_NOT_USE",

      reasonCode:
        "NO_MX",

      reason:
        "The domain has no usable MX record for mailbox verification. The email must not be used for sending.",

      decisionConfidence:
        POLICY_CONFIDENCE,

      verificationStatus:
        "NO_MX",

      retryable:
        false,

      manualReviewRequired:
        false,

      verificationId:
        verification.verificationId,
    });
  }

  /*
  ==================================================
  8. DNS ERROR
  ==================================================
  */

  if (
    verification.status === "DNS_ERROR"
  ) {

    return createResult({

      allowed:
        false,

      decision:
        "RETRY_VERIFICATION",

      reasonCode:
        "DNS_ERROR",

      reason:
        "DNS verification did not complete reliably. Verification should be retried before sending.",

      decisionConfidence:
        POLICY_CONFIDENCE,

      verificationStatus:
        "DNS_ERROR",

      retryable:
        true,

      manualReviewRequired:
        false,

      verificationId:
        verification.verificationId,
    });
  }

  /*
  ==================================================
  9. SMTP ERROR
  ==================================================
  */

  if (
    verification.status === "SMTP_ERROR"
  ) {

    return createResult({

      allowed:
        false,

      decision:
        "RETRY_VERIFICATION",

      reasonCode:
        "SMTP_ERROR",

      reason:
        "SMTP verification did not produce a definitive mailbox result. Verification should be retried before sending.",

      decisionConfidence:
        POLICY_CONFIDENCE,

      verificationStatus:
        "SMTP_ERROR",

      retryable:
        true,

      manualReviewRequired:
        false,

      verificationId:
        verification.verificationId,
    });
  }

  /*
  ==================================================
  10. UNKNOWN
  ==================================================
  */

  if (
    verification.status === "UNKNOWN"
  ) {

    return createResult({

      allowed:
        false,

      decision:
        "MANUAL_REVIEW",

      reasonCode:
        "UNKNOWN_VERIFICATION",

      reason:
        "The verification evidence is inconclusive. The email must not be automatically approved for sending.",

      decisionConfidence:
        POLICY_CONFIDENCE,

      verificationStatus:
        "UNKNOWN",

      retryable:
        false,

      manualReviewRequired:
        true,

      verificationId:
        verification.verificationId,
    });
  }

  /*
  ==================================================
  11. VERIFIED
  ==================================================
  */

  if (
    verification.status === "VERIFIED"
  ) {

    /*
    ------------------------------------------
    Supporting evidence must agree.
    ------------------------------------------
    */

    if (
      verification.mailboxVerified !== true ||
      verification.verificationPassed !== true ||
      verification.retryable !== false
    ) {

      return createResult({

        allowed:
          false,

        decision:
          "MANUAL_REVIEW",

        reasonCode:
          "STATUS_NOT_VERIFIED",

        reason:
          "The verification record is marked VERIFIED, but its supporting evidence is inconsistent. Sending is blocked.",

        decisionConfidence:
          POLICY_CONFIDENCE,

        verificationStatus:
          "VERIFIED",

        retryable:
          false,

        manualReviewRequired:
          true,

        verificationId:
          verification.verificationId,
      });
    }

    /*
    ------------------------------------------
    Freshness
    ------------------------------------------
    */

    const freshness =
      checkVerificationFreshness(
        verification,
        now
      );

    if (
      !freshness.valid
    ) {

      return createResult({

        allowed:
          false,

        decision:
          "RETRY_VERIFICATION",

        reasonCode:
          freshness.reasonCode,

        reason:
          freshness.reason,

        decisionConfidence:
          POLICY_CONFIDENCE,

        verificationStatus:
          "VERIFIED",

        retryable:
          true,

        manualReviewRequired:
          false,

        verificationId:
          verification.verificationId,
      });
    }

    /*
    ------------------------------------------
    FINAL APPROVAL
    ------------------------------------------
    */

    return createResult({

      allowed:
        true,

      decision:
        "USE_EMAIL",

      reasonCode:
        "VERIFIED_MAILBOX",

      reason:
        "The mailbox was definitively verified, the verification is authoritative and fresh, and the address is eligible for sending.",

      decisionConfidence:
        POLICY_CONFIDENCE,

      verificationStatus:
        "VERIFIED",

      retryable:
        false,

      manualReviewRequired:
        false,

      verificationId:
        verification.verificationId,
    });
  }

  /*
  ==================================================
  12. FAIL CLOSED
  ==================================================
  */

  return createResult({

    allowed:
      false,

    decision:
      "MANUAL_REVIEW",

    reasonCode:
      "INVALID_POLICY_INPUT",

    reason:
      "The verification status is not recognized by the current send policy. Sending is blocked.",

    decisionConfidence:
      POLICY_CONFIDENCE,

    verificationStatus:
      "UNKNOWN",

    retryable:
      false,

    manualReviewRequired:
      true,

    verificationId:
      verification.verificationId,
  });
}

/*
==================================================
VERIFICATION RESULT -> AUTHORITATIVE RECORD
==================================================

This is the compatibility boundary between the
verification engine and the send policy.

IMPORTANT:

The caller must be trusted server-side code.

Do NOT expose this function directly as a client
authorization mechanism.
==================================================
*/

export function createAuthoritativeVerificationRecord(
  verification: VerificationStatusResult,
  options: {
    verificationId: string;
    emailAddress: string;
    verifiedAt?: string;
    expiresAt?: string | null;
    verifierVersion?: string;
  }
): AuthoritativeVerificationRecord {

  if (
    !verification ||
    typeof verification !== "object"
  ) {
    throw new Error(
      "INVALID_VERIFICATION_RESULT"
    );
  }

  const verificationId =
    options.verificationId.trim();

  const emailAddress =
    options.emailAddress
      .trim()
      .toLowerCase();

  if (!verificationId) {
    throw new Error(
      "VERIFICATION_ID_REQUIRED"
    );
  }

  if (!emailAddress) {
    throw new Error(
      "EMAIL_ADDRESS_REQUIRED"
    );
  }

  const verifiedAt =
    options.verifiedAt ??
    new Date().toISOString();

  return {
    ...verification,

    verificationId,

    emailAddress,

    verifiedAt,

    expiresAt:
      options.expiresAt ??
      null,

    verifierVersion:
      options.verifierVersion ??
      "verification-engine",

    /*
    Server-side trusted boundary.
    */
    authoritative:
      true,
  };
}

/*
==================================================
CONVENIENCE FUNCTION
==================================================
*/

export function getSendEligibility(
  verification:
    AuthoritativeVerificationRecord,
  now?: Date | string | number
): SendEligibilityResult {

  return evaluateSendEligibility({
    verification,
    now,
  });
}

/*
==================================================
BOOLEAN CHECK
==================================================
*/

export function canSendEmail(
  verification:
    AuthoritativeVerificationRecord,
  now?: Date | string | number
): boolean {

  return getSendEligibility(
    verification,
    now
  ).allowed;
}

/*
==================================================
RETRY CHECK
==================================================
*/

export function shouldRetryVerification(
  verification:
    AuthoritativeVerificationRecord,
  now?: Date | string | number
): boolean {

  return getSendEligibility(
    verification,
    now
  ).retryable;
}

/*
==================================================
MANUAL REVIEW CHECK
==================================================
*/

export function requiresManualReview(
  verification:
    AuthoritativeVerificationRecord,
  now?: Date | string | number
): boolean {

  return getSendEligibility(
    verification,
    now
  ).manualReviewRequired;
}

/*
==================================================
PERMANENT BLOCK CHECK
==================================================
*/

export function isPermanentlyBlocked(
  verification:
    AuthoritativeVerificationRecord,
  now?: Date | string | number
): boolean {

  const result =
    getSendEligibility(
      verification,
      now
    );

  return (
    result.allowed === false &&
    result.retryable === false &&
    result.manualReviewRequired === false
  );
}

/*
==================================================
DEFAULT STATUS POLICY
==================================================
*/

export function getDefaultPolicyForStatus(
  status: VerificationStatus
): {
  allowed: boolean;
  decision: SendEligibilityDecision;
  retryable: boolean;
  manualReviewRequired: boolean;
} {

  switch (status) {

    case "VERIFIED":
      return {
        allowed: true,
        decision: "USE_EMAIL",
        retryable: false,
        manualReviewRequired: false,
      };

    case "INVALID":
      return {
        allowed: false,
        decision: "DO_NOT_USE",
        retryable: false,
        manualReviewRequired: false,
      };

    case "CATCH_ALL":
      return {
        allowed: false,
        decision: "MANUAL_REVIEW",
        retryable: false,
        manualReviewRequired: true,
      };

    case "TEMPORARY":
      return {
        allowed: false,
        decision: "RETRY_VERIFICATION",
        retryable: true,
        manualReviewRequired: false,
      };

    case "NO_MX":
      return {
        allowed: false,
        decision: "DO_NOT_USE",
        retryable: false,
        manualReviewRequired: false,
      };

    case "DNS_ERROR":
    case "SMTP_ERROR":
      return {
        allowed: false,
        decision: "RETRY_VERIFICATION",
        retryable: true,
        manualReviewRequired: false,
      };

    case "UNKNOWN":
    default:
      return {
        allowed: false,
        decision: "MANUAL_REVIEW",
        retryable: false,
        manualReviewRequired: true,
      };
  }
}

/*
==================================================
DEFAULT EXPORT
==================================================
*/

export default {
  evaluateSendEligibility,

  createAuthoritativeVerificationRecord,

  getSendEligibility,

  canSendEmail,

  shouldRetryVerification,

  requiresManualReview,

  isPermanentlyBlocked,

  getDefaultPolicyForStatus,
};