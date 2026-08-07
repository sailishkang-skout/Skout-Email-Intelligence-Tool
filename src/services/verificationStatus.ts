/*
==================================================
VERIFICATION STATUS ENGINE
==================================================

Purpose:

This service converts lower-level email verification
evidence into ONE deterministic verification decision.

It does NOT:

- perform DNS
- perform MX lookups
- perform SMTP
- perform catch-all detection
- access the database
- perform outbound sending
- decide campaign/send policy

It ONLY interprets verification evidence.

==================================================
SUPPORTED STATUSES
==================================================

VERIFIED
INVALID
CATCH_ALL
TEMPORARY
NO_MX
DNS_ERROR
SMTP_ERROR
UNKNOWN

==================================================
IMPORTANT SAFETY RULE
==================================================

Only definitive evidence may produce:

    VERIFIED
    INVALID

Everything else remains non-definitive.

A catch-all domain MUST NEVER become VERIFIED.

A temporary SMTP response MUST NEVER become INVALID.

A connection/DNS failure MUST NEVER become INVALID.

==================================================
*/

export const VERIFICATION_STATUS_VERSION = "1.0.0";

/*
==================================================
VERIFICATION STATUS
==================================================
*/

export type VerificationStatus =
  | "VERIFIED"
  | "INVALID"
  | "CATCH_ALL"
  | "TEMPORARY"
  | "NO_MX"
  | "DNS_ERROR"
  | "SMTP_ERROR"
  | "UNKNOWN";

/*
==================================================
REASON CODES
==================================================
*/

export type VerificationReasonCode =
  | "MAILBOX_VERIFIED"
  | "MAILBOX_REJECTED"
  | "CATCH_ALL_DOMAIN"
  | "TEMPORARY_SMTP_FAILURE"
  | "NO_MX_RECORD"
  | "DNS_LOOKUP_FAILED"
  | "SMTP_CONNECTION_FAILED"
  | "SMTP_VERIFICATION_FAILED"
  | "UNKNOWN_VERIFICATION_RESULT";

/*
==================================================
TRI-STATE EVIDENCE
==================================================

Use explicit evidence states where possible.

This prevents:

    false

from meaning both:

    "definitively false"

and:

    "we don't know"

==================================================
*/

export type EvidenceState =
  | "CONFIRMED"
  | "REJECTED"
  | "UNKNOWN";

/*
==================================================
INPUT
==================================================
*/

export interface VerificationStatusInput {
  /*
  ------------------------------------------
  MX / DNS
  ------------------------------------------
  */

  mxAvailable: boolean;

  mxHosts?: string[];

  primaryMX?: string | null;

  /*
  ------------------------------------------
  SMTP
  ------------------------------------------
  */

  responseCode?: number | null;

  responseMessage?: string | null;

  /*
  ------------------------------------------
  Mailbox
  ------------------------------------------
  */

  mailboxExists: boolean;

  smtpValid: boolean;

  /*
  ------------------------------------------
  Catch-all
  ------------------------------------------
  */

  catchAll: boolean;

  /*
  ------------------------------------------
  Retry / orchestration
  ------------------------------------------

  This should only be true when the verifier
  explicitly knows that the current attempt
  did not reach a definitive result.
  */

  retryRequired: boolean;

  retryReason?: string | null;

  /*
  ------------------------------------------
  Error
  ------------------------------------------
  */

  error?: string | null;

  /*
  ------------------------------------------
  Error classification
  ------------------------------------------
  */

  errorType?:
    | "DNS"
    | "SMTP"
    | "NONE"
    | null;
}

/*
==================================================
OUTPUT
==================================================
*/

export interface VerificationStatusResult {
  status: VerificationStatus;

  mailboxVerified: boolean;

  verificationPassed: boolean;

  retryable: boolean;

  reasonCode: VerificationReasonCode;

  reason: string;

  /*
  ------------------------------------------
  Deterministic engine metadata
  ------------------------------------------
  */

  statusEngineVersion: string;
}

/*
==================================================
HELPERS
==================================================
*/

function isSuccessfulSMTPResponse(
  responseCode: number | null | undefined
): boolean {
  return (
    typeof responseCode === "number" &&
    Number.isFinite(responseCode) &&
    responseCode >= 200 &&
    responseCode < 300
  );
}

function isTemporarySMTPResponse(
  responseCode: number | null | undefined
): boolean {
  return (
    typeof responseCode === "number" &&
    Number.isFinite(responseCode) &&
    responseCode >= 400 &&
    responseCode < 500
  );
}

function isPermanentSMTPFailure(
  responseCode: number | null | undefined
): boolean {
  return (
    typeof responseCode === "number" &&
    Number.isFinite(responseCode) &&
    responseCode >= 500 &&
    responseCode < 600
  );
}

function hasError(
  value: string | null | undefined
): boolean {
  return (
    typeof value === "string" &&
    value.trim().length > 0
  );
}

/*
==================================================
RESULT BUILDERS
==================================================
*/

function verifiedResult(): VerificationStatusResult {
  return {
    status: "VERIFIED",

    mailboxVerified: true,

    verificationPassed: true,

    retryable: false,

    reasonCode: "MAILBOX_VERIFIED",

    reason:
      "The SMTP server provided definitive evidence that the mailbox exists.",

    statusEngineVersion:
      VERIFICATION_STATUS_VERSION,
  };
}

function invalidResult(): VerificationStatusResult {
  return {
    status: "INVALID",

    mailboxVerified: false,

    verificationPassed: false,

    retryable: false,

    reasonCode: "MAILBOX_REJECTED",

    reason:
      "The receiving SMTP server permanently rejected the mailbox.",

    statusEngineVersion:
      VERIFICATION_STATUS_VERSION,
  };
}

function catchAllResult(): VerificationStatusResult {
  return {
    status: "CATCH_ALL",

    mailboxVerified: false,

    verificationPassed: false,

    retryable: false,

    reasonCode: "CATCH_ALL_DOMAIN",

    reason:
      "The domain accepts arbitrary recipients, so mailbox-specific existence cannot be confirmed.",

    statusEngineVersion:
      VERIFICATION_STATUS_VERSION,
  };
}

function temporaryResult(
  reason?: string | null
): VerificationStatusResult {
  const normalizedReason =
    hasError(reason)
      ? reason!.trim()
      : null;

  return {
    status: "TEMPORARY",

    mailboxVerified: false,

    verificationPassed: false,

    retryable: true,

    reasonCode:
      "TEMPORARY_SMTP_FAILURE",

    reason:
      normalizedReason
        ? `The SMTP server returned a temporary result: ${normalizedReason}`
        : "The SMTP server returned a temporary response. Verification should be retried.",

    statusEngineVersion:
      VERIFICATION_STATUS_VERSION,
  };
}

function noMXResult(): VerificationStatusResult {
  return {
    status: "NO_MX",

    mailboxVerified: false,

    verificationPassed: false,

    retryable: false,

    reasonCode: "NO_MX_RECORD",

    reason:
      "The domain has no usable MX record for SMTP mailbox verification.",

    statusEngineVersion:
      VERIFICATION_STATUS_VERSION,
  };
}

function dnsErrorResult(
  reason?: string | null
): VerificationStatusResult {
  const normalizedReason =
    hasError(reason)
      ? reason!.trim()
      : null;

  return {
    status: "DNS_ERROR",

    mailboxVerified: false,

    verificationPassed: false,

    retryable: true,

    reasonCode:
      "DNS_LOOKUP_FAILED",

    reason:
      normalizedReason
        ? `DNS lookup failed: ${normalizedReason}`
        : "The DNS lookup could not be completed reliably. Verification should be retried.",

    statusEngineVersion:
      VERIFICATION_STATUS_VERSION,
  };
}

function smtpConnectionErrorResult(
  reason?: string | null
): VerificationStatusResult {
  const normalizedReason =
    hasError(reason)
      ? reason!.trim()
      : null;

  return {
    status: "SMTP_ERROR",

    mailboxVerified: false,

    verificationPassed: false,

    retryable: true,

    reasonCode:
      "SMTP_CONNECTION_FAILED",

    reason:
      normalizedReason
        ? `The SMTP connection could not be completed: ${normalizedReason}`
        : "The SMTP connection could not be completed. Verification should be retried.",

    statusEngineVersion:
      VERIFICATION_STATUS_VERSION,
  };
}

function smtpVerificationErrorResult(
  reason?: string | null
): VerificationStatusResult {
  const normalizedReason =
    hasError(reason)
      ? reason!.trim()
      : null;

  return {
    status: "SMTP_ERROR",

    mailboxVerified: false,

    verificationPassed: false,

    retryable: true,

    reasonCode:
      "SMTP_VERIFICATION_FAILED",

    reason:
      normalizedReason
        ? `SMTP verification could not establish a definitive result: ${normalizedReason}`
        : "SMTP verification could not establish a definitive result. Verification should be retried.",

    statusEngineVersion:
      VERIFICATION_STATUS_VERSION,
  };
}

function unknownResult(): VerificationStatusResult {
  return {
    status: "UNKNOWN",

    mailboxVerified: false,

    verificationPassed: false,

    retryable: false,

    reasonCode:
      "UNKNOWN_VERIFICATION_RESULT",

    reason:
      "The available verification evidence is contradictory or insufficient to make a definitive decision.",

    statusEngineVersion:
      VERIFICATION_STATUS_VERSION,
  };
}

/*
==================================================
MAIN DECISION ENGINE
==================================================

Evidence precedence:

1. Invalid input
2. Explicit DNS failure
3. Definitive permanent SMTP rejection
4. Catch-all
5. Temporary SMTP response
6. Definitive successful SMTP verification
7. SMTP connection/verification error
8. No MX
9. Unknown

The important principle is:

    NEVER GUESS.

==================================================
*/

export function buildVerificationStatus(
  input: VerificationStatusInput
): VerificationStatusResult {
  /*
  ==================================================
  1. BASIC INPUT SAFETY
  ==================================================
  */

  if (
    !input ||
    typeof input !== "object"
  ) {
    return unknownResult();
  }

  /*
  ==================================================
  2. EXPLICIT DNS ERROR
  ==================================================
  */

  if (
    input.errorType === "DNS"
  ) {
    return dnsErrorResult(
      input.error
    );
  }

  /*
  ==================================================
  3. DEFINITIVE SMTP PERMANENT REJECTION
  ==================================================

  A real 5xx rejection is stronger than a generic
  SMTP error classification.

  Example:

      550
      mailboxExists = false

  MUST become INVALID.
  */

  if (
    isPermanentSMTPFailure(
      input.responseCode
    ) &&
    input.catchAll === false &&
    input.mailboxExists === false
  ) {
    return invalidResult();
  }

  /*
  ==================================================
  4. CATCH-ALL
  ==================================================

  Catch-all is checked before successful SMTP.

  A 250 response on a catch-all domain does NOT
  prove that the requested mailbox exists.
  */

  if (
    input.catchAll === true
  ) {
    return catchAllResult();
  }

  /*
  ==================================================
  5. TEMPORARY SMTP RESPONSE
  ==================================================

  4xx is never INVALID.
  */

  if (
    isTemporarySMTPResponse(
      input.responseCode
    )
  ) {
    return temporaryResult(
      input.responseMessage ??
      input.retryReason
    );
  }

  /*
  ==================================================
  6. DEFINITIVE SUCCESS
  ==================================================

  ALL conditions are required.

      MX available
      2xx response
      smtpValid
      mailboxExists
      no catch-all
      no retry
  ==================================================
  */

  if (
    input.mxAvailable === true &&
    isSuccessfulSMTPResponse(
      input.responseCode
    ) &&
    input.smtpValid === true &&
    input.mailboxExists === true &&
    input.catchAll === false &&
    input.retryRequired === false
  ) {
    return verifiedResult();
  }

  /*
  ==================================================
  7. EXPLICIT SMTP ERROR
  ==================================================
  */

  if (
    input.errorType === "SMTP"
  ) {
    /*
    If we have already received a definitive
    SMTP response, it was handled above.

    Therefore an explicit SMTP error here means
    verification did not complete.
    */

    if (
      hasError(input.error)
    ) {
      return smtpConnectionErrorResult(
        input.error
      );
    }

    return smtpVerificationErrorResult(
      input.retryReason
    );
  }

  /*
  ==================================================
  8. RETRY REQUIRED
  ==================================================
  */

  if (
    input.retryRequired === true
  ) {
    /*
    If MX exists, the verifier reached the
    SMTP stage but did not obtain definitive
    evidence.
    */

    if (
      input.mxAvailable === true
    ) {
      return smtpVerificationErrorResult(
        input.retryReason ??
        input.error
      );
    }

    /*
    No MX + retry requested means DNS/domain
    resolution was not sufficiently conclusive.
    */

    return dnsErrorResult(
      input.retryReason ??
      input.error
    );
  }

  /*
  ==================================================
  9. NO MX
  ==================================================
  */

  if (
    input.mxAvailable === false
  ) {
    return noMXResult();
  }

  /*
  ==================================================
  10. SMTP ERROR WITHOUT RESPONSE
  ==================================================

  MX exists but SMTP did not produce a usable
  definitive response.
  */

  if (
    input.mxAvailable === true &&
    input.responseCode == null &&
    (
      hasError(input.error) ||
      input.smtpValid === false ||
      input.mailboxExists === false
    )
  ) {
    return smtpConnectionErrorResult(
      input.error
    );
  }

  /*
  ==================================================
  11. UNKNOWN
  ==================================================

  Never manufacture a verification result.
  */

  return unknownResult();
}

/*
==================================================
BOOLEAN HELPERS
==================================================
*/

export function isVerificationPassed(
  result: VerificationStatusResult
): boolean {
  return result.verificationPassed === true;
}

export function isMailboxVerified(
  result: VerificationStatusResult
): boolean {
  return result.mailboxVerified === true;
}

export function isRetryableVerification(
  result: VerificationStatusResult
): boolean {
  return result.retryable === true;
}

export function isDefinitivelyInvalid(
  result: VerificationStatusResult
): boolean {
  return result.status === "INVALID";
}

export function isCatchAllVerification(
  result: VerificationStatusResult
): boolean {
  return result.status === "CATCH_ALL";
}

export function isTemporaryVerification(
  result: VerificationStatusResult
): boolean {
  return result.status === "TEMPORARY";
}

export function isVerified(
  result: VerificationStatusResult
): boolean {
  return (
    result.status === "VERIFIED" &&
    result.mailboxVerified === true &&
    result.verificationPassed === true &&
    result.retryable === false
  );
}

/*
==================================================
STATUS PRIORITY
==================================================

This is NOT "goodness".

It represents how definitive the classification is.
==================================================
*/

export function getVerificationStatusPriority(
  status: VerificationStatus
): number {
  switch (status) {
    case "VERIFIED":
    case "INVALID":
      return 100;

    case "CATCH_ALL":
    case "NO_MX":
      return 90;

    case "TEMPORARY":
      return 50;

    case "DNS_ERROR":
    case "SMTP_ERROR":
      return 40;

    case "UNKNOWN":
      return 0;

    default:
      return 0;
  }
}

/*
==================================================
STATUS VALIDATION
==================================================
*/

export function isVerificationStatus(
  value: unknown
): value is VerificationStatus {
  switch (value) {
    case "VERIFIED":
    case "INVALID":
    case "CATCH_ALL":
    case "TEMPORARY":
    case "NO_MX":
    case "DNS_ERROR":
    case "SMTP_ERROR":
    case "UNKNOWN":
      return true;

    default:
      return false;
  }
}

/*
==================================================
REASON CODE VALIDATION
==================================================
*/

export function isVerificationReasonCode(
  value: unknown
): value is VerificationReasonCode {
  switch (value) {
    case "MAILBOX_VERIFIED":
    case "MAILBOX_REJECTED":
    case "CATCH_ALL_DOMAIN":
    case "TEMPORARY_SMTP_FAILURE":
    case "NO_MX_RECORD":
    case "DNS_LOOKUP_FAILED":
    case "SMTP_CONNECTION_FAILED":
    case "SMTP_VERIFICATION_FAILED":
    case "UNKNOWN_VERIFICATION_RESULT":
      return true;

    default:
      return false;
  }
}

/*
==================================================
DEFAULT EXPORT
==================================================
*/

export default {
  buildVerificationStatus,

  isVerificationPassed,

  isMailboxVerified,

  isRetryableVerification,

  isDefinitivelyInvalid,

  isCatchAllVerification,

  isTemporaryVerification,

  isVerified,

  getVerificationStatusPriority,

  isVerificationStatus,

  isVerificationReasonCode,
};