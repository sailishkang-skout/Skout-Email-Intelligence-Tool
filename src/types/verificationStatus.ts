/*
==================================================
CANONICAL VERIFICATION STATUS
==================================================

This is the single high-level classification for
an email verification attempt.

IMPORTANT:

Do not use `success: boolean` as the only source
of truth.

A failed verification can mean many different
things:

- INVALID
- CATCH_ALL
- TEMPORARY
- NO_MX
- DNS_ERROR
- SMTP_ERROR
- UNKNOWN

Downstream systems should consume this status.
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
STATUS METADATA
==================================================
*/

export interface VerificationStatusResult {
  status: VerificationStatus;

  /*
   * Whether the mailbox itself has been
   * definitively verified.
   */
  mailboxVerified: boolean;

  /*
   * Whether sending is potentially safe from
   * an existence-verification perspective.
   *
   * This does NOT override sendEligibility.
   */
  verificationPassed: boolean;

  /*
   * Whether the result should normally be retried.
   */
  retryable: boolean;

  /*
   * Stable machine-readable explanation.
   */
  reasonCode: string;

  /*
   * Human-readable explanation.
   */
  reason: string;
}

/*
==================================================
STATUS BUILDERS
==================================================
*/

export function buildVerificationStatus(
  input: {
    mxAvailable: boolean;

    responseCode: number | null;

    mailboxExists: boolean;

    smtpValid: boolean;

    catchAll: boolean;

    retryRequired: boolean;

    smtpError?: string | null;

    catchAllError?: string | null;
  }
): VerificationStatusResult {

  /*
  ==================================================
  1. CATCH-ALL
  ==================================================

  Catch-all takes precedence over SMTP 250.

  A server accepting the recipient does not prove
  that the mailbox exists when arbitrary recipients
  are accepted.
  */

  if (input.catchAll) {
    return {
      status: "CATCH_ALL",

      mailboxVerified: false,

      verificationPassed: false,

      retryable: false,

      reasonCode:
        "CATCH_ALL_DOMAIN",

      reason:
        "The domain accepts arbitrary recipients, so mailbox existence cannot be confirmed."
    };
  }

  /*
  ==================================================
  2. NO MX
  ==================================================
  */

  if (!input.mxAvailable) {

    /*
     * If retryRequired is true and there was an
     * actual DNS/network error, classify it as
     * DNS_ERROR instead of NO_MX.
     */

    const errorText =
      `${input.smtpError ?? ""}`.toLowerCase();

    if (
      errorText.includes("enotfound") ||
      errorText.includes("eai_again") ||
      errorText.includes("dns") ||
      errorText.includes("querymx")
    ) {
      return {
        status: "DNS_ERROR",

        mailboxVerified: false,

        verificationPassed: false,

        retryable: true,

        reasonCode:
          "DNS_LOOKUP_FAILED",

        reason:
          "The domain could not be resolved through DNS."
      };
    }

    return {
      status: "NO_MX",

      mailboxVerified: false,

      verificationPassed: false,

      retryable: false,

      reasonCode:
        "NO_MX_RECORD",

      reason:
        "The domain does not have a usable MX record."
    };
  }

  /*
  ==================================================
  3. RETRYABLE / TEMPORARY
  ==================================================
  */

  if (input.retryRequired) {

    return {
      status: "TEMPORARY",

      mailboxVerified: false,

      verificationPassed: false,

      retryable: true,

      reasonCode:
        "TEMPORARY_SMTP_FAILURE",

      reason:
        "The verification could not be completed because the mail server returned a temporary or retryable error."
    };
  }

  /*
  ==================================================
  4. DEFINITIVE SUCCESS
  ==================================================
  */

  if (
    input.responseCode !== null &&
    input.responseCode >= 200 &&
    input.responseCode < 300 &&
    input.smtpValid &&
    input.mailboxExists
  ) {

    return {
      status: "VERIFIED",

      mailboxVerified: true,

      verificationPassed: true,

      retryable: false,

      reasonCode:
        "SMTP_MAILBOX_CONFIRMED",

      reason:
        "The SMTP server accepted the recipient and the mailbox was confirmed."
    };
  }

  /*
  ==================================================
  5. DEFINITIVE INVALID
  ==================================================
  */

  if (
    input.responseCode !== null &&
    input.responseCode >= 500 &&
    input.responseCode < 600 &&
    !input.mailboxExists
  ) {

    return {
      status: "INVALID",

      mailboxVerified: false,

      verificationPassed: false,

      retryable: false,

      reasonCode:
        "SMTP_MAILBOX_REJECTED",

      reason:
        "The SMTP server definitively rejected the recipient mailbox."
    };
  }

  /*
  ==================================================
  6. SMTP ERROR
  ==================================================
  */

  if (input.smtpError) {

    return {
      status: "SMTP_ERROR",

      mailboxVerified: false,

      verificationPassed: false,

      retryable: true,

      reasonCode:
        "SMTP_VERIFICATION_ERROR",

      reason:
        "An SMTP verification error prevented definitive mailbox classification."
    };
  }

  /*
  ==================================================
  7. UNKNOWN
  ==================================================
  */

  return {
    status: "UNKNOWN",

    mailboxVerified: false,

    verificationPassed: false,

    retryable: false,

    reasonCode:
      "VERIFICATION_INCONCLUSIVE",

    reason:
      "The available verification evidence was insufficient to definitively classify the mailbox."
  };
}