/*
==================================================
OUTBOUND EMAIL SERVICE
==================================================

Purpose
-------

This service is the application-level boundary
between outbound email requests and the email
transport provider.

Architecture:

    HTTP / Worker / Controller
            ↓
    OutboundEmailService
            ↓
    Outbound Send Guard
            ↓
    Send Eligibility
            ↓
    EmailSendProvider
            ↓
    SMTP / SES / Resend / SendGrid / Mock

IMPORTANT SAFETY RULE
---------------------

The provider MUST ONLY be called when:

    guard.allowed === true

and therefore:

    eligibility.decision === "USE_EMAIL"

This service NEVER performs:

    - DNS verification
    - MX verification
    - SMTP mailbox verification
    - catch-all detection
    - mailbox existence checks
    - lead scoring
    - enrichment
    - email verification

The verification system owns verification.

The send eligibility system owns policy.

The outbound send guard owns the final policy
authorization.

This service owns orchestration and provider
transport invocation.

==================================================
*/

import type {
  AuthoritativeVerificationRecord,
  SendEligibilityResult,
} from "./sendEligibility.js";

import {
  checkOutboundSendEligibility,
  type OutboundSendGuardResult,
} from "./outboundSendGuard.js";

import {
  EmailSendProviderError,
  isEmailSendProviderError,
  type EmailSendProvider,
  type EmailSendRequest,
  type EmailSendResult,
} from "./emailSendProvider.js";

/*
==================================================
VERSION
==================================================
*/

export const OUTBOUND_EMAIL_SERVICE_VERSION =
  "1.1.0";

/*
==================================================
OUTBOUND DECISION
==================================================
*/

export type OutboundDecision =
  | "SAFE_TO_SEND"
  | "DO_NOT_SEND"
  | "RETRY_VERIFICATION"
  | "MANUAL_REVIEW";

/*
==================================================
OUTBOUND REASON CODE
==================================================
*/

export type OutboundReasonCode =
  | "VERIFIED_MAILBOX"
  | "MAILBOX_INVALID"
  | "HARD_BOUNCE"
  | "TEMPORARY_SMTP_FAILURE"
  | "NO_MX"
  | "CATCH_ALL"
  | "DISPOSABLE_EMAIL"
  | "LOW_CONFIDENCE"
  | "UNKNOWN";

/*
==================================================
INPUT
==================================================
*/

export interface OutboundEmailInput {

  /*
  Sender address.
  */

  from: string;

  /*
  Recipient address.
  */

  to: string;

  /*
  Email subject.
  */

  subject: string;

  /*
  Optional plain-text body.
  */

  text?: string;

  /*
  Optional HTML body.
  */

  html?: string;

  /*
  MUST be an authoritative server-side
  verification record.
  */

  verification:
    AuthoritativeVerificationRecord;

  /*
  Injectable clock for deterministic testing.

  This is passed to the send eligibility engine.
  */

  now?: Date | string | number;
}

/*
==================================================
RESULT
==================================================
*/

export interface OutboundEmailResult {

  success: boolean;

  email: string;

  decision: OutboundDecision;

  reasonCode: OutboundReasonCode;

  reason: string;

  /*
  Policy decision confidence.

  This is NOT mailbox confidence.
  */

  confidence: number;

  messageId: string | null;

  provider: string | null;

  error: string | null;

  /*
  Policy version used by the eligibility engine.
  */

  policyVersion: string | null;

  /*
  Verification record identity.

  Useful for auditability.
  */

  verificationId: string | null;

  /*
  Service version.
  */

  serviceVersion: string;
}

/*
==================================================
EMAIL NORMALIZATION
==================================================
*/

function normalizeEmail(
  value: unknown
): string {

  if (
    typeof value !== "string"
  ) {
    return "";
  }

  return value
    .trim()
    .toLowerCase();
}

/*
==================================================
STRING NORMALIZATION
==================================================
*/

function normalizeString(
  value: unknown
): string | null {

  if (
    typeof value !== "string"
  ) {
    return null;
  }

  const normalized =
    value.trim();

  return normalized.length > 0
    ? normalized
    : null;
}

/*
==================================================
EMAIL FORMAT VALIDATION
==================================================

This validates syntax only.

It does NOT determine:

    - mailbox existence
    - MX
    - SMTP
    - catch-all
    - deliverability

Those remain verification responsibilities.
==================================================
*/

function isValidEmail(
  email: string
): boolean {

  if (
    !email ||
    email.length > 254
  ) {
    return false;
  }

  const atIndex =
    email.lastIndexOf("@");

  if (
    atIndex <= 0 ||
    atIndex !== email.indexOf("@")
  ) {
    return false;
  }

  const localPart =
    email.slice(
      0,
      atIndex
    );

  const domain =
    email.slice(
      atIndex + 1
    );

  if (
    !localPart ||
    !domain
  ) {
    return false;
  }

  if (
    localPart.length > 64 ||
    domain.length > 253
  ) {
    return false;
  }

  if (
    !domain.includes(".")
  ) {
    return false;
  }

  if (
    domain.startsWith(".") ||
    domain.endsWith(".") ||
    domain.includes("..")
  ) {
    return false;
  }

  if (
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(
      localPart
    )
  ) {
    return false;
  }

  if (
    !/^[a-z0-9.-]+$/i.test(
      domain
    )
  ) {
    return false;
  }

  return true;
}

/*
==================================================
PROVIDER NAME NORMALIZATION
==================================================
*/

function normalizeProviderName(
  value: unknown
): string | null {

  return normalizeString(
    value
  );
}

/*
==================================================
ERROR MESSAGE
==================================================
*/

function getErrorMessage(
  error: unknown
): string {

  if (
    error instanceof Error &&
    error.message.trim()
  ) {
    return error.message.trim();
  }

  if (
    typeof error === "string" &&
    error.trim()
  ) {
    return error.trim();
  }

  return "UNKNOWN_EMAIL_SEND_ERROR";
}

/*
==================================================
MAP POLICY DECISION
==================================================
*/

function mapDecision(
  decision: OutboundSendGuardResult["decision"]
): OutboundDecision {

  switch (decision) {

    case "USE_EMAIL":
      return "SAFE_TO_SEND";

    case "DO_NOT_USE":
      return "DO_NOT_SEND";

    case "RETRY_VERIFICATION":
      return "RETRY_VERIFICATION";

    case "MANUAL_REVIEW":
      return "MANUAL_REVIEW";

    default:
      return "MANUAL_REVIEW";
  }
}

/*
==================================================
MAP POLICY REASON CODE
==================================================
*/

function mapReasonCode(
  reasonCode:
    OutboundSendGuardResult["reasonCode"]
): OutboundReasonCode {

  switch (reasonCode) {

    case "VERIFIED_MAILBOX":
      return "VERIFIED_MAILBOX";

    case "INVALID_MAILBOX":
      return "MAILBOX_INVALID";

    case "CATCH_ALL":
      return "CATCH_ALL";

    case "TEMPORARY_VERIFICATION":
      return "TEMPORARY_SMTP_FAILURE";

    case "NO_MX":
      return "NO_MX";

    case "DNS_ERROR":
      return "UNKNOWN";

    case "SMTP_ERROR":
      return "TEMPORARY_SMTP_FAILURE";

    case "UNKNOWN_VERIFICATION":
      return "UNKNOWN";

    case "STATUS_NOT_VERIFIED":
      return "UNKNOWN";

    case "VERIFICATION_EXPIRED":
      return "UNKNOWN";

    case "VERIFICATION_NOT_YET_VALID":
      return "UNKNOWN";

    case "VERIFICATION_NOT_AUTHORITATIVE":
      return "UNKNOWN";

    case "INVALID_POLICY_INPUT":
      return "UNKNOWN";

    default:
      return "UNKNOWN";
  }
}

/*
==================================================
PROVIDER RESULT NORMALIZATION
==================================================
*/

function normalizeProviderResult(
  result: EmailSendResult
): {
  success: boolean;
  messageId: string | null;
  provider: string | null;
  error: string | null;
} {

  const accepted =
    result.accepted === true;

  const messageId =
    normalizeString(
      result.messageId
    );

  const provider =
    normalizeProviderName(
      result.provider
    );

  const response =
    normalizeString(
      result.response
    );

  return {
    success:
      accepted,

    messageId,

    provider,

    error:
      accepted
        ? null
        : response ??
          "EMAIL_PROVIDER_SEND_FAILED",
  };
}

/*
==================================================
INVALID INPUT RESULT
==================================================
*/

function invalidInputResult(
  email: string,
  reason: string,
  error: string,
  verificationId: string | null = null
): OutboundEmailResult {

  return {

    success:
      false,

    email,

    decision:
      "DO_NOT_SEND",

    reasonCode:
      "UNKNOWN",

    reason,

    confidence:
      100,

    messageId:
      null,

    provider:
      null,

    error,

    policyVersion:
      null,

    verificationId,

    serviceVersion:
      OUTBOUND_EMAIL_SERVICE_VERSION,
  };
}

/*
==================================================
BLOCKED RESULT
==================================================
*/

function blockedResult(
  email: string,
  eligibility: SendEligibilityResult
): OutboundEmailResult {

  return {

    success:
      false,

    email,

    decision:
      mapDecision(
        eligibility.decision
      ),

    reasonCode:
      mapReasonCode(
        eligibility.reasonCode
      ),

    reason:
      eligibility.reason,

    confidence:
      eligibility.decisionConfidence,

    messageId:
      null,

    provider:
      null,

    error:
      null,

    policyVersion:
      eligibility.policyVersion,

    verificationId:
      eligibility.verificationId,

    serviceVersion:
      OUTBOUND_EMAIL_SERVICE_VERSION,
  };
}

/*
==================================================
GUARD RESULT -> ELIGIBILITY RESULT
==================================================

The guard intentionally exposes the policy decision
needed by this transport layer.

This helper creates a minimal compatibility object
for the blocked response.

==================================================
*/

function guardResultToOutboundResult(
  email: string,
  guard: OutboundSendGuardResult,
  verificationId: string | null,
  policyVersion: string
): OutboundEmailResult {

  return {

    success:
      false,

    email,

    decision:
      mapDecision(
        guard.decision
      ),

    reasonCode:
      mapReasonCode(
        guard.reasonCode
      ),

    reason:
      guard.reason,

    confidence:
      guard.confidence,

    messageId:
      null,

    provider:
      null,

    error:
      null,

    policyVersion,

    verificationId,

    serviceVersion:
      OUTBOUND_EMAIL_SERVICE_VERSION,
  };
}

/*
==================================================
AUTHORITATIVE VERIFICATION RECORD VALIDATION
==================================================

This validates the minimum structure required by
the outbound service.

The actual policy engine performs the canonical
validation and fail-closed decision.

We intentionally do NOT cast arbitrary objects.
==================================================
*/

export function isAuthoritativeVerificationRecord(
  value: unknown
): value is AuthoritativeVerificationRecord {

  if (
    !value ||
    typeof value !== "object"
  ) {
    return false;
  }

  const record =
    value as Partial<
      AuthoritativeVerificationRecord
    >;

  /*
  ------------------------------------------
  Identity
  ------------------------------------------
  */

  if (
    typeof record.verificationId !== "string" ||
    record.verificationId.trim().length === 0
  ) {
    return false;
  }

  if (
    typeof record.emailAddress !== "string" ||
    record.emailAddress.trim().length === 0
  ) {
    return false;
  }

  /*
  ------------------------------------------
  Provenance
  ------------------------------------------
  */

  if (
    typeof record.verifiedAt !== "string" ||
    record.verifiedAt.trim().length === 0
  ) {
    return false;
  }

  if (
    record.expiresAt !== null &&
    typeof record.expiresAt !== "string"
  ) {
    return false;
  }

  if (
    typeof record.verifierVersion !== "string" ||
    record.verifierVersion.trim().length === 0
  ) {
    return false;
  }

  if (
    typeof record.authoritative !== "boolean"
  ) {
    return false;
  }

  /*
  ------------------------------------------
  Canonical verification state
  ------------------------------------------
  */

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

  return true;
}

/*
==================================================
PROVIDER REQUEST VALIDATION
==================================================
*/

function validateProviderRequest(
  request: EmailSendRequest
): string | null {

  if (
    typeof request.from !== "string" ||
    request.from.trim().length === 0
  ) {
    return "INVALID_FROM_ADDRESS";
  }

  if (
    typeof request.to !== "string" ||
    request.to.trim().length === 0
  ) {
    return "INVALID_TO_ADDRESS";
  }

  if (
    typeof request.subject !== "string" ||
    request.subject.trim().length === 0
  ) {
    return "INVALID_SUBJECT";
  }

  const hasText =
    typeof request.text === "string" &&
    request.text.trim().length > 0;

  const hasHtml =
    typeof request.html === "string" &&
    request.html.trim().length > 0;

  if (
    !hasText &&
    !hasHtml
  ) {
    return "EMAIL_BODY_REQUIRED";
  }

  return null;
}

/*
==================================================
VERIFY EMAIL CONSISTENCY
==================================================
*/

function verificationMatchesRecipient(
  verification: AuthoritativeVerificationRecord,
  recipient: string
): boolean {

  return (
    normalizeEmail(
      verification.emailAddress
    ) ===
    normalizeEmail(
      recipient
    )
  );
}

/*
==================================================
MAIN OUTBOUND SEND
==================================================

CRITICAL ORDER:

1. Validate request.
2. Validate recipient syntax.
3. Validate authoritative verification.
4. Validate verification/recipient consistency.
5. Evaluate outbound send guard.
6. STOP if not allowed.
7. Validate provider request.
8. Call provider.
9. Normalize provider result.

The provider is never called before step 6.
==================================================
*/

export async function sendOutboundEmail(
  provider: EmailSendProvider,
  input: OutboundEmailInput
): Promise<OutboundEmailResult> {

  /*
  ==================================================
  1. BASIC INPUT VALIDATION
  ==================================================
  */

  if (
    !input ||
    typeof input !== "object"
  ) {

    return invalidInputResult(
      "",
      "The outbound email input is missing or invalid.",
      "INVALID_OUTBOUND_EMAIL_INPUT"
    );
  }

  if (
    !provider ||
    typeof provider.send !== "function"
  ) {

    return invalidInputResult(
      "",
      "The email send provider is missing or invalid.",
      "INVALID_EMAIL_SEND_PROVIDER"
    );
  }

  /*
  ==================================================
  2. NORMALIZE RECIPIENT
  ==================================================
  */

  const email =
    normalizeEmail(
      input.to
    );

  if (
    !email
  ) {

    return invalidInputResult(
      "",
      "A recipient email address is required.",
      "INVALID_TO_ADDRESS"
    );
  }

  /*
  ==================================================
  3. EMAIL SYNTAX
  ==================================================
  */

  if (
    !isValidEmail(
      email
    )
  ) {

    return invalidInputResult(
      email,
      "The recipient email address has an invalid format.",
      "INVALID_TO_ADDRESS"
    );
  }

  /*
  ==================================================
  4. AUTHORITATIVE VERIFICATION
  ==================================================
  */

  if (
    !isAuthoritativeVerificationRecord(
      input.verification
    )
  ) {

    return invalidInputResult(
      email,
      "The outbound send requires a valid authoritative verification record.",
      "AUTHORITATIVE_VERIFICATION_REQUIRED"
    );
  }

  const verification =
    input.verification;

  /*
  ==================================================
  5. VERIFIED EMAIL CONSISTENCY
  ==================================================
  */

  if (
    !verificationMatchesRecipient(
      verification,
      email
    )
  ) {

    return invalidInputResult(
      email,
      "The verification record does not belong to the recipient email address.",
      "VERIFICATION_EMAIL_MISMATCH",
      verification.verificationId
    );
  }

  /*
  ==================================================
  6. OUTBOUND SEND GUARD
  ==================================================

  THIS IS THE FINAL POLICY AUTHORIZATION.

  The guard delegates to sendEligibility.ts.

  The provider must NEVER be called unless:

      guard.allowed === true

  ==================================================
  */

  const guard =
    checkOutboundSendEligibility({
      verification,

      now:
        input.now,
    });

  /*
  ==================================================
  7. FAIL CLOSED
  ==================================================

  Any result other than allowed === true blocks
  transport invocation.

  This includes:

      INVALID
      CATCH_ALL
      TEMPORARY
      NO_MX
      DNS_ERROR
      SMTP_ERROR
      UNKNOWN
      expired VERIFIED
      non-authoritative VERIFIED
      inconsistent VERIFIED
      invalid policy input

  ==================================================
  */

  if (
    guard.allowed !== true
  ) {

    /*
    We intentionally construct the public result
    from the guard.

    No provider call occurs here.
    */

    return guardResultToOutboundResult(
      email,
      guard,
      verification.verificationId,
      /*
      The guard currently does not expose the policy
      version directly.

      Keep the public field stable while avoiding
      duplication of policy logic.
      */

      "unknown"
    );
  }

  /*
  ==================================================
  8. FINAL SEND AUTHORIZATION
  ==================================================

  Defense-in-depth:

  Even though allowed === true is the required
  transport authorization, explicitly require
  USE_EMAIL as well.

  ==================================================
  */

  if (
    guard.decision !== "USE_EMAIL"
  ) {

    return guardResultToOutboundResult(
      email,
      guard,
      verification.verificationId,
      "unknown"
    );
  }

  /*
  ==================================================
  9. PROVIDER REQUEST
  ==================================================
  */

  const providerRequest:
    EmailSendRequest = {

    from:
      typeof input.from === "string"
        ? input.from.trim()
        : "",

    to:
      email,

    subject:
      typeof input.subject === "string"
        ? input.subject.trim()
        : "",

    ...(typeof input.text === "string"
      ? {
          text:
            input.text,
        }
      : {}),

    ...(typeof input.html === "string"
      ? {
          html:
            input.html,
        }
      : {}),
  };

  /*
  ==================================================
  10. PROVIDER REQUEST VALIDATION
  ==================================================
  */

  const providerValidationError =
    validateProviderRequest(
      providerRequest
    );

  if (
    providerValidationError
  ) {

    return invalidInputResult(
      email,
      "The outbound email request is invalid.",
      providerValidationError,
      verification.verificationId
    );
  }

  /*
  ==================================================
  11. PROVIDER SEND
  ==================================================

  THIS IS THE ONLY PROVIDER INVOCATION IN THIS
  SERVICE.

  It is unreachable unless:

      guard.allowed === true
      AND
      guard.decision === "USE_EMAIL"

  ==================================================
  */

  let providerResult:
    EmailSendResult;

  try {

    providerResult =
      await provider.send(
        providerRequest
      );

  } catch (
    error: unknown
  ) {

    /*
    ----------------------------------------------
    Provider-specific failure
    ----------------------------------------------
    */

    if (
      isEmailSendProviderError(
        error
      )
    ) {

      return {

        success:
          false,

        email,

        decision:
          error.retryable
            ? "RETRY_VERIFICATION"
            : "DO_NOT_SEND",

        reasonCode:
          error.retryable
            ? "TEMPORARY_SMTP_FAILURE"
            : "UNKNOWN",

        reason:
          error.message,

        confidence:
          100,

        messageId:
          null,

        provider:
          normalizeProviderName(
            error.provider
          ),

        error:
          error.code ??
          error.response ??
          error.message,

        policyVersion:
          "unknown",

        verificationId:
          verification.verificationId,

        serviceVersion:
          OUTBOUND_EMAIL_SERVICE_VERSION,
      };
    }

    /*
    ----------------------------------------------
    Unexpected provider failure
    ----------------------------------------------
    */

    const message =
      getErrorMessage(
        error
      );

    return {

      success:
        false,

      email,

      decision:
        "DO_NOT_SEND",

      reasonCode:
        "UNKNOWN",

      reason:
        "The email provider failed unexpectedly. The message was not confirmed as accepted.",

      confidence:
        100,

      messageId:
        null,

      provider:
        null,

      error:
        message,

      policyVersion:
        "unknown",

      verificationId:
        verification.verificationId,

      serviceVersion:
        OUTBOUND_EMAIL_SERVICE_VERSION,
    };
  }

  /*
  ==================================================
  12. PROVIDER RESULT VALIDATION
  ==================================================
  */

  if (
    !providerResult ||
    typeof providerResult !== "object"
  ) {

    return {

      success:
        false,

      email,

      decision:
        "DO_NOT_SEND",

      reasonCode:
        "UNKNOWN",

      reason:
        "The email provider returned an invalid response.",

      confidence:
        100,

      messageId:
        null,

      provider:
        null,

      error:
        "INVALID_EMAIL_PROVIDER_RESPONSE",

      policyVersion:
        "unknown",

      verificationId:
        verification.verificationId,

      serviceVersion:
        OUTBOUND_EMAIL_SERVICE_VERSION,
    };
  }

  /*
  ==================================================
  13. NORMALIZE PROVIDER RESULT
  ==================================================
  */

  const normalizedProvider =
    normalizeProviderResult(
      providerResult
    );

  /*
  ==================================================
  14. PROVIDER ACCEPTED
  ==================================================
  */

  if (
    normalizedProvider.success
  ) {

    return {

      success:
        true,

      email,

      decision:
        "SAFE_TO_SEND",

      reasonCode:
        "VERIFIED_MAILBOX",

      reason:
        "The mailbox was authorized for sending and the email provider accepted the message for submission.",

      confidence:
        guard.confidence,

      messageId:
        normalizedProvider.messageId,

      provider:
        normalizedProvider.provider,

      error:
        null,

      policyVersion:
        "unknown",

      verificationId:
        verification.verificationId,

      serviceVersion:
        OUTBOUND_EMAIL_SERVICE_VERSION,
    };
  }

  /*
  ==================================================
  15. PROVIDER REJECTED
  ==================================================
  */

  return {

    success:
      false,

    email,

    decision:
      "DO_NOT_SEND",

    reasonCode:
      "UNKNOWN",

    reason:
      "The email provider did not accept the message.",

    confidence:
      guard.confidence,

    messageId:
      null,

    provider:
      normalizedProvider.provider,

    error:
      normalizedProvider.error ??
      "EMAIL_PROVIDER_SEND_FAILED",

    policyVersion:
      "unknown",

    verificationId:
      verification.verificationId,

    serviceVersion:
      OUTBOUND_EMAIL_SERVICE_VERSION,
  };
}

/*
==================================================
SAFE BOOLEAN CHECK
==================================================
*/

export function canOutboundEmailBeSent(
  input: OutboundEmailInput
): boolean {

  if (
    !input ||
    typeof input !== "object"
  ) {
    return false;
  }

  if (
    !isAuthoritativeVerificationRecord(
      input.verification
    )
  ) {
    return false;
  }

  const email =
    normalizeEmail(
      input.to
    );

  if (
    !email ||
    !isValidEmail(email)
  ) {
    return false;
  }

  if (
    !verificationMatchesRecipient(
      input.verification,
      email
    )
  ) {
    return false;
  }

  const guard =
    checkOutboundSendEligibility({
      verification:
        input.verification,

      now:
        input.now,
    });

  return (
    guard.allowed === true &&
    guard.decision === "USE_EMAIL"
  );
}

/*
==================================================
DEFAULT EXPORT
==================================================
*/

export default {
  sendOutboundEmail,

  canOutboundEmailBeSent,

  isAuthoritativeVerificationRecord,
};