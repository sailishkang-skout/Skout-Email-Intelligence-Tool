import {
  getPatternHistory,
  recordPatternObservation,
  type PatternHistoryRecord
} from "./patternHistory.js";

/*
==================================================
PATTERN EVIDENCE ENGINE
==================================================

Purpose:

Pattern recognizer:
    "This email looks like first.last@domain."

Pattern history:
    "This pattern has historically worked
     X times for this domain."

SMTP:
    "The recipient was accepted/rejected."

This service decides whether the current
verification result is strong enough to teach
the persistent pattern-learning system.

IMPORTANT:

Only definitive SMTP evidence is recorded.

SUCCESS:
    - 2xx SMTP response
    - smtpValid === true
    - mailboxExists === true
    - catchAll === false

FAILURE:
    - 5xx SMTP response
    - mailboxExists === false
    - catchAll === false

NOT RECORDED:
    - invalid email
    - invalid pattern
    - DNS failure
    - missing MX
    - timeout
    - connection failure
    - 4xx SMTP response
    - retryable response
    - catch-all acceptance
    - ambiguous result
    - persistence failure

CRITICAL RULE:

A 250 SMTP response on a catch-all domain
does NOT prove that the specific mailbox exists.

Therefore:

    catchAll === true

MUST NEVER produce pattern evidence.
==================================================
*/

/*
==================================================
INPUT
==================================================
*/

export interface PatternEvidenceInput {
  email: string;

  pattern: string;

  smtpValid: boolean;

  mailboxExists: boolean;

  responseCode: number | null;

  responseMessage: string;

  catchAll: boolean;

  source:
    | "SMTP"
    | "MANUAL"
    | "IMPORTED"
    | "OTHER";

  verificationId?: string | null;
}

/*
==================================================
OUTCOME
==================================================
*/

export type PatternEvidenceOutcome =
  | "SUCCESS"
  | "FAILURE"
  | "NOT_RECORDED";

/*
==================================================
RESULT
==================================================
*/

export interface PatternEvidenceResult {
  recorded: boolean;

  outcome: PatternEvidenceOutcome;

  reasonCode: string;

  history: PatternHistoryRecord | null;
}

/*
==================================================
NORMALIZE EMAIL
==================================================
*/

function normalizeEmail(
  email: string
): string {
  return email
    .trim()
    .toLowerCase();
}

/*
==================================================
EXTRACT DOMAIN
==================================================
*/

function extractDomain(
  email: string
): string | null {
  const atIndex =
    email.lastIndexOf("@");

  if (
    atIndex <= 0 ||
    atIndex >= email.length - 1
  ) {
    return null;
  }

  const domain =
    email
      .slice(atIndex + 1)
      .trim()
      .toLowerCase();

  return domain || null;
}

/*
==================================================
NORMALIZE DOMAIN
==================================================
*/

function normalizeDomain(
  domain: string
): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(
      /^https?:\/\//,
      ""
    )
    .replace(
      /^www\./,
      ""
    )
    .split("/")[0]
    ?.trim() ?? "";
}

/*
==================================================
NORMALIZE PATTERN
==================================================
*/

function normalizePattern(
  pattern: string
): string {
  return pattern
    .trim()
    .toLowerCase();
}

/*
==================================================
CURRENT HISTORY
==================================================

better-sqlite3 is synchronous.

The Promise wrapper is retained here so this
service remains compatible with the existing
async verification orchestrator.
==================================================
*/

async function getCurrentHistory(
  domain: string,
  pattern: string
): Promise<PatternHistoryRecord | null> {

  try {

    const history =
      await getPatternHistory(
        domain,
        pattern
      );

    if (!history) {
      return null;
    }

    return history;

  } catch (
    error: unknown
  ) {

    console.error(
      "[PatternEvidence] Failed to read pattern history:",
      error
    );

    return null;
  }
}

/*
==================================================
SMTP CLASSIFICATION
==================================================
*/

function isSuccessfulSMTPResponse(
  responseCode: number | null
): boolean {

  return (
    responseCode !== null &&
    Number.isFinite(
      responseCode
    ) &&
    responseCode >= 200 &&
    responseCode < 300
  );
}

function isPermanentSMTPFailure(
  responseCode: number | null
): boolean {

  return (
    responseCode !== null &&
    Number.isFinite(
      responseCode
    ) &&
    responseCode >= 500 &&
    responseCode < 600
  );
}

function isTemporarySMTPResponse(
  responseCode: number | null
): boolean {

  return (
    responseCode !== null &&
    Number.isFinite(
      responseCode
    ) &&
    responseCode >= 400 &&
    responseCode < 500
  );
}

/*
==================================================
INPUT VALIDATION
==================================================
*/

function validateSource(
  source: PatternEvidenceInput["source"]
): boolean {

  return (
    source === "SMTP" ||
    source === "MANUAL" ||
    source === "IMPORTED" ||
    source === "OTHER"
  );
}

/*
==================================================
NORMALIZED INPUT
==================================================
*/

interface NormalizedPatternEvidenceInput {
  email: string;

  domain: string;

  pattern: string;

  smtpValid: boolean;

  mailboxExists: boolean;

  responseCode: number | null;

  responseMessage: string;

  catchAll: boolean;

  source:
    | "SMTP"
    | "MANUAL"
    | "IMPORTED"
    | "OTHER";

  verificationId: string | null;
}

/*
==================================================
NORMALIZE + VALIDATE INPUT
==================================================
*/

function normalizeInput(
  input: PatternEvidenceInput
):
  | {
      valid: true;
      value: NormalizedPatternEvidenceInput;
    }
  | {
      valid: false;
      reasonCode: string;
    } {

  if (
    !input ||
    typeof input !== "object"
  ) {
    return {
      valid: false,
      reasonCode:
        "PATTERN_EVIDENCE_INVALID_INPUT"
    };
  }

  if (
    typeof input.email !== "string" ||
    !input.email.trim()
  ) {
    return {
      valid: false,
      reasonCode:
        "PATTERN_EVIDENCE_INVALID_EMAIL"
    };
  }

  if (
    typeof input.pattern !== "string" ||
    !input.pattern.trim()
  ) {
    return {
      valid: false,
      reasonCode:
        "PATTERN_EVIDENCE_INVALID_PATTERN"
    };
  }

  if (
    typeof input.smtpValid !== "boolean"
  ) {
    return {
      valid: false,
      reasonCode:
        "PATTERN_EVIDENCE_INVALID_SMTP_VALID"
    };
  }

  if (
    typeof input.mailboxExists !== "boolean"
  ) {
    return {
      valid: false,
      reasonCode:
        "PATTERN_EVIDENCE_INVALID_MAILBOX_STATE"
    };
  }

  if (
    input.responseCode !== null &&
    (
      typeof input.responseCode !== "number" ||
      !Number.isFinite(
        input.responseCode
      )
    )
  ) {
    return {
      valid: false,
      reasonCode:
        "PATTERN_EVIDENCE_INVALID_RESPONSE_CODE"
    };
  }

  if (
    typeof input.catchAll !== "boolean"
  ) {
    return {
      valid: false,
      reasonCode:
        "PATTERN_EVIDENCE_INVALID_CATCH_ALL"
    };
  }

  if (
    !validateSource(
      input.source
    )
  ) {
    return {
      valid: false,
      reasonCode:
        "PATTERN_EVIDENCE_INVALID_SOURCE"
    };
  }

  const email =
    normalizeEmail(
      input.email
    );

  const rawDomain =
    extractDomain(
      email
    );

  if (!rawDomain) {
    return {
      valid: false,
      reasonCode:
        "PATTERN_EVIDENCE_INVALID_EMAIL"
    };
  }

  const domain =
    normalizeDomain(
      rawDomain
    );

  if (!domain) {
    return {
      valid: false,
      reasonCode:
        "PATTERN_EVIDENCE_INVALID_DOMAIN"
    };
  }

  const pattern =
    normalizePattern(
      input.pattern
    );

  if (!pattern) {
    return {
      valid: false,
      reasonCode:
        "PATTERN_EVIDENCE_INVALID_PATTERN"
    };
  }

  const responseMessage =
    typeof input.responseMessage === "string"
      ? input.responseMessage.trim()
      : "";

  const verificationId =
    typeof input.verificationId === "string" &&
    input.verificationId.trim()
      ? input.verificationId.trim()
      : null;

  return {
    valid: true,

    value: {
      email,

      domain,

      pattern,

      smtpValid:
        input.smtpValid,

      mailboxExists:
        input.mailboxExists,

      responseCode:
        input.responseCode,

      responseMessage,

      catchAll:
        input.catchAll,

      source:
        input.source,

      verificationId
    }
  };
}

/*
==================================================
MAIN EVALUATOR
==================================================
*/

export async function evaluatePatternEvidence(
  input: PatternEvidenceInput
): Promise<PatternEvidenceResult> {

  /*
  ==================================================
  1. VALIDATE + NORMALIZE
  ==================================================
  */

  const normalized =
    normalizeInput(
      input
    );

  if (
    !normalized.valid
  ) {
    return {
      recorded: false,

      outcome:
        "NOT_RECORDED",

      reasonCode:
        normalized.reasonCode,

      history: null
    };
  }

  const {
    email,
    domain,
    pattern,
    smtpValid,
    mailboxExists,
    responseCode,
    responseMessage,
    catchAll,
    source,
    verificationId
  } =
    normalized.value;

  /*
  ==================================================
  2. CATCH-ALL PROTECTION
  ==================================================

  This check MUST happen before SMTP success.

  Example:

      SMTP = 250
      mailboxExists = true
      smtpValid = true
      catchAll = true

  This does NOT prove the mailbox exists.

  Therefore:

      DO NOT RECORD
      DO NOT TEACH PATTERN
  ==================================================
  */

  if (
    catchAll === true
  ) {

    return {
      recorded: false,

      outcome:
        "NOT_RECORDED",

      reasonCode:
        "PATTERN_EVIDENCE_CATCH_ALL",

      history:
        await getCurrentHistory(
          domain,
          pattern
        )
    };
  }

  /*
  ==================================================
  3. TEMPORARY SMTP RESPONSE
  ==================================================

  4xx responses are temporary.

  Examples:

      421
      450
      451
      452

  These cannot teach pattern success/failure.
  ==================================================
  */

  if (
    isTemporarySMTPResponse(
      responseCode
    )
  ) {

    return {
      recorded: false,

      outcome:
        "NOT_RECORDED",

      reasonCode:
        "PATTERN_EVIDENCE_TEMPORARY_SMTP",

      history:
        await getCurrentHistory(
          domain,
          pattern
        )
    };
  }

  /*
  ==================================================
  4. RETRYABLE / UNKNOWN RESPONSE
  ==================================================

  No SMTP response means we do not have
  definitive mailbox evidence.
  ==================================================
  */

  if (
    responseCode === null
  ) {

    return {
      recorded: false,

      outcome:
        "NOT_RECORDED",

      reasonCode:
        "PATTERN_EVIDENCE_NO_SMTP_RESPONSE",

      history:
        await getCurrentHistory(
          domain,
          pattern
        )
    };
  }

  /*
  ==================================================
  5. DEFINITIVE SUCCESS
  ==================================================

  ALL conditions are required:

      2xx SMTP response
      smtpValid === true
      mailboxExists === true
      catchAll === false

  This is the ONLY way to record SUCCESS.
  ==================================================
  */

  const success =
    catchAll === false &&
    isSuccessfulSMTPResponse(
      responseCode
    ) &&
    smtpValid === true &&
    mailboxExists === true;

  if (
    success
  ) {

    try {

      await recordPatternObservation({
        domain,

        pattern,

        outcome:
          "SUCCESS",

        source,

        responseCode,

        verificationId
      });

    } catch (
      error: unknown
    ) {

      console.error(
        "[PatternEvidence] Failed to record SUCCESS observation:",
        error
      );

      return {
        recorded: false,

        outcome:
          "NOT_RECORDED",

        reasonCode:
          "PATTERN_EVIDENCE_RECORD_FAILED",

        history:
          await getCurrentHistory(
            domain,
            pattern
          )
      };
    }

    /*
    Read aggregate history AFTER the
    observation has been committed.
    */

    const history =
      await getCurrentHistory(
        domain,
        pattern
      );

    return {
      recorded: true,

      outcome:
        "SUCCESS",

      reasonCode:
        "SMTP_MAILBOX_CONFIRMED",

      history
    };
  }

  /*
  ==================================================
  6. DEFINITIVE FAILURE
  ==================================================

  ALL conditions are required:

      5xx SMTP response
      mailboxExists === false
      catchAll === false

  This is the ONLY way to record FAILURE.
  ==================================================
  */

  const permanentFailure =
    catchAll === false &&
    isPermanentSMTPFailure(
      responseCode
    ) &&
    mailboxExists === false;

  if (
    permanentFailure
  ) {

    try {

      await recordPatternObservation({
        domain,

        pattern,

        outcome:
          "FAILURE",

        source,

        responseCode,

        verificationId
      });

    } catch (
      error: unknown
    ) {

      console.error(
        "[PatternEvidence] Failed to record FAILURE observation:",
        error
      );

      return {
        recorded: false,

        outcome:
          "NOT_RECORDED",

        reasonCode:
          "PATTERN_EVIDENCE_RECORD_FAILED",

        history:
          await getCurrentHistory(
            domain,
            pattern
          )
      };
    }

    /*
    Read aggregate history AFTER the
    observation has been committed.
    */

    const history =
      await getCurrentHistory(
        domain,
        pattern
      );

    return {
      recorded: true,

      outcome:
        "FAILURE",

      reasonCode:
        "SMTP_MAILBOX_REJECTED",

      history
    };
  }

  /*
  ==================================================
  7. INCONCLUSIVE
  ==================================================

  Everything else is deliberately ignored.

  Examples:

      200 + mailboxExists false
      250 + smtpValid false
      250 + mailboxExists false
      500 + mailboxExists true
      strange SMTP response
      inconsistent SMTP state
  ==================================================
  */

  return {
    recorded: false,

    outcome:
      "NOT_RECORDED",

    reasonCode:
      "PATTERN_EVIDENCE_INCONCLUSIVE",

    history:
      await getCurrentHistory(
        domain,
        pattern
      )
  };
}

/*
==================================================
CLASSIFY WITHOUT WRITING
==================================================

This function determines what the evidence means
WITHOUT modifying the database.

Useful for:

    - tests
    - scoring
    - debugging
    - API previews
    - verification orchestration

Possible results:

    SUCCESS
    FAILURE
    NOT_RECORDED
==================================================
*/

export function classifyPatternEvidence(
  input: PatternEvidenceInput
): PatternEvidenceOutcome {

  /*
  ==================================================
  1. VALIDATE + NORMALIZE
  ==================================================
  */

  const normalized =
    normalizeInput(
      input
    );

  if (
    !normalized.valid
  ) {
    return "NOT_RECORDED";
  }

  const {
    smtpValid,
    mailboxExists,
    responseCode,
    catchAll
  } =
    normalized.value;

  /*
  ==================================================
  2. CATCH-ALL
  ==================================================

  Catch-all ALWAYS wins.

  Even:

      250
      smtpValid = true
      mailboxExists = true

  must remain unverified if:

      catchAll = true
  ==================================================
  */

  if (
    catchAll === true
  ) {
    return "NOT_RECORDED";
  }

  /*
  ==================================================
  3. TEMPORARY SMTP
  ==================================================
  */

  if (
    isTemporarySMTPResponse(
      responseCode
    )
  ) {
    return "NOT_RECORDED";
  }

  /*
  ==================================================
  4. DEFINITIVE SUCCESS
  ==================================================
  */

  const success =
    catchAll === false &&
    isSuccessfulSMTPResponse(
      responseCode
    ) &&
    smtpValid === true &&
    mailboxExists === true;

  if (
    success
  ) {
    return "SUCCESS";
  }

  /*
  ==================================================
  5. DEFINITIVE FAILURE
  ==================================================
  */

  const failure =
    catchAll === false &&
    isPermanentSMTPFailure(
      responseCode
    ) &&
    mailboxExists === false;

  if (
    failure
  ) {
    return "FAILURE";
  }

  /*
  ==================================================
  6. INCONCLUSIVE
  ==================================================
  */

  return "NOT_RECORDED";
}

/*
==================================================
DEFAULT EXPORT
==================================================
*/

export default evaluatePatternEvidence;