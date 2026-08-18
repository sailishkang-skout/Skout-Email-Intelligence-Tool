export type ConfidenceLevel =
  | "VERY_HIGH"
  | "HIGH"
  | "MEDIUM"
  | "LOW"
  | "VERY_LOW";

export type ConfidenceStatus =
  | "VERIFIED"
  | "LIKELY_VALID"
  | "UNCERTAIN"
  | "LIKELY_INVALID"
  | "INVALID"
  | "CATCH_ALL"
  | "TEMPORARY_FAILURE";

export interface ConfidenceEvidenceInput {
  mxAvailable: boolean;
  smtpValid: boolean;
  mailboxExists: boolean | null;
  responseCode: number | null;

  catchAll: boolean;

  catchAllConfidence?:
    | "high"
    | "medium"
    | "low"
    | "unknown";

  retryRequired: boolean;

  providerDetected: boolean;

  patternConfidence?: number | null;
  patternSuccessRate?: number | null;
  patternAttempts?: number;


  patternReliabilityScore?: number | null;

  patternRiskLevel?:
    | "LOW"
    | "MEDIUM"
    | "HIGH"
    | "VERY_LOW"
    | "CRITICAL"
    | null;

  patternBayesianConfidence?: number | null;

  patternWilsonScore?: number | null;

  patternStabilityScore?: number | null;

  patternTrend?:
    | "IMPROVING"
    | "STABLE"
    | "DECLINING"
    | "UNKNOWN"
    | null;

  patternCompetitiveAdvantage?: number | null;
}

export interface ConfidenceBreakdown {
  base: number;
  mx: number;
  smtp: number;
  mailbox: number;
  catchAll: number;
  provider: number;
  patternIntelligence: number;
  pattern: number;
  retry: number;
  responseCode: number;
  total: number;
}

export interface ConfidenceResult {
  score: number;
  level: ConfidenceLevel;
  status: ConfidenceStatus;
  breakdown: ConfidenceBreakdown;
}

function clamp(
  value: number,
  min = 0,
  max = 100
): number {
  return Math.max(
    min,
    Math.min(max, value)
  );
}

/*
==================================================
PATTERN EVIDENCE
==================================================
*/

function calculatePatternEvidence(
  input: ConfidenceEvidenceInput
): number {

  const confidence =
    input.patternConfidence ?? 0;

  const successRate =
    input.patternSuccessRate ?? 0;

  const attempts =
    Math.max(
      0,
      input.patternAttempts ?? 0
    );

  if (attempts <= 0) {
    return 0;
  }

  const confidencePercentage =
    confidence <= 1
      ? confidence * 100
      : confidence;

  const successPercentage =
    successRate <= 1
      ? successRate * 100
      : successRate;

  const signal =
    Math.max(
      confidencePercentage,
      successPercentage
    );

  /*
  More historical attempts = more trust,
  but never allow pattern history to dominate
  direct SMTP evidence.
  */

  const sampleMultiplier =
    Math.min(
      1,
      Math.log10(attempts + 1) / 2
    );

  return clamp(
    signal *
      sampleMultiplier *
      0.15,
    0,
    15
  );
}

/*
==================================================
PATTERN INTELLIGENCE EVIDENCE
==================================================
*/

function calculatePatternIntelligenceEvidence(
  input: ConfidenceEvidenceInput
): number {


  const reliability =
    input.patternReliabilityScore ?? 0;


  const bayesian =
    input.patternBayesianConfidence ?? 0;


  const wilson =
    input.patternWilsonScore ?? 0;


  const stability =
    input.patternStabilityScore ?? 0;


  const competitive =
    input.patternCompetitiveAdvantage ?? 0;


  let score =
    (
      reliability * 0.35
    )
    +
    (
      bayesian * 0.20
    )
    +
    (
      wilson * 0.20
    )
    +
    (
      stability * 0.15
    )
    +
    (
      competitive * 0.10
    );


  /*
  Risk adjustment
  */

  switch (
    input.patternRiskLevel
  ) {

    case "VERY_LOW":
    case "LOW":

      score += 5;

      break;


    case "HIGH":

      score -= 10;

      break;


    case "CRITICAL":

      score -= 20;

      break;

  }


  /*
  Trend adjustment
  */

  if (
    input.patternTrend === "IMPROVING"
  ) {

    score += 5;

  }


  if (
    input.patternTrend === "DECLINING"
  ) {

    score -= 10;

  }


  return clamp(
    score * 0.15,
    0,
    15
  );

}

/*
==================================================
SMTP RESPONSE EVIDENCE
==================================================
*/

function calculateResponseCodeEvidence(
  code: number | null
): number {

  if (code === null) {
    return 0;
  }

  /*
  2xx = recipient accepted.
  Positive signal, but NOT proof by itself.
  */

  if (
    code >= 200 &&
    code < 300
  ) {
    return 10;
  }

  /*
  5xx = permanent rejection.
  */

  if (
    code >= 500 &&
    code < 600
  ) {
    return -25;
  }

  /*
  4xx = temporary response.
  */

  if (
    code >= 400 &&
    code < 500
  ) {
    return -10;
  }

  return 0;
}

/*
==================================================
CATCH-ALL EVIDENCE
==================================================
*/

function calculateCatchAllPenalty(
  input: ConfidenceEvidenceInput
): number {

  if (!input.catchAll) {
    return 0;
  }

  switch (
    input.catchAllConfidence
  ) {

    case "high":
      /*
      Strong evidence that the domain accepts
      arbitrary recipients.

      This makes mailbox-level verification
      unreliable.
      */

      return -55;

    case "medium":
      return -45;

    case "low":
      return -30;

    default:
      return -40;
  }
}

/*
==================================================
LEVEL
==================================================
*/

function getConfidenceLevel(
  score:number
):ConfidenceLevel {

  if(score >= 90){
    return "VERY_HIGH";
  }

  if(score >= 75){
    return "HIGH";
  }

  if(score >= 55){
    return "MEDIUM";
  }

  if(score >= 30){
    return "LOW";
  }

  return "VERY_LOW";
}

/*
==================================================
STATUS
==================================================
*/

function getConfidenceStatus(
  input: ConfidenceEvidenceInput,
  score: number
): ConfidenceStatus {

  /*
  Catch-all takes precedence.

  Even if SMTP accepts the recipient,
  that does not prove the mailbox exists.
  */

  if (input.catchAll) {
    return "CATCH_ALL";
  }

  if (
    input.retryRequired &&
    input.mailboxExists === false
  ) {
    return "TEMPORARY_FAILURE";
  }

  if (
  input.responseCode !== null &&
  input.responseCode >= 500 &&
  input.responseCode < 600 &&
  input.mailboxExists === false
) {

  return "INVALID";
}

  if (
    input.mailboxExists === true &&
    input.smtpValid &&
    score >= 80
  ) {
    return "VERIFIED";
  }

  if (
    input.mailboxExists === true &&
    input.smtpValid &&
    score >= 60
  ) {
    return "LIKELY_VALID";
  }

  if (score < 30) {
    return "INVALID";
  }

  return "UNCERTAIN";
}

/*
==================================================
MAIN ENGINE
==================================================
*/

export function calculateEvidenceConfidence(
  input: ConfidenceEvidenceInput
): ConfidenceResult {

  const base = 50;

  const mx =
    input.mxAvailable
      ? 15
      : -15;

  const smtp =
  input.smtpValid
    ? 25
    : (
        input.responseCode !== null &&
        input.responseCode >= 500 &&
        input.responseCode < 600
      )
        ? 20
        : 0;

  const mailbox =
  input.mailboxExists === true
    ? 35
    : (
        input.responseCode !== null &&
        input.responseCode >= 500 &&
        input.responseCode < 600
      )
        ? 25
        : 0;

  const catchAll =
    calculateCatchAllPenalty(
      input
    );

  const provider =
    input.providerDetected
      ? 5
      : 0;

  const pattern =
  calculatePatternEvidence(
    input
  );


const patternIntelligence =
  calculatePatternIntelligenceEvidence(
    input
  );

  const retry =
    input.retryRequired
      ? -20
      : 0;

  const responseCode =
    calculateResponseCodeEvidence(
      input.responseCode
    );

  /*
  ==================================================
  RAW SCORE
  ==================================================
  */

 const rawScore =
    base +
    mx +
    smtp +
    mailbox +
    catchAll +
    provider +
    pattern +
    patternIntelligence +
    retry +
    responseCode;

  let score =
    Math.round(
      clamp(rawScore) * 100
    ) / 100;


/*
==================================================
INVALID MAILBOX OVERRIDE
==================================================

A definitive SMTP 5xx rejection is strong evidence.

Confidence represents confidence in the classification,
not probability the mailbox exists.
==================================================
*/

  if(
    input.responseCode !== null &&
    input.responseCode >= 500 &&
    input.responseCode < 600 &&
    input.mailboxExists === false
  ){

    score = 95;

  }
/*
  ==================================================
  CATCH-ALL HARD CAP
  ==================================================
  */

  if (input.catchAll) {

    const cap =
      input.catchAllConfidence === "high"
        ? 59
        : input.catchAllConfidence === "medium"
          ? 64
          : 69;

    score =
      Math.min(
        score,
        cap
      );
  }


  const level =
    getConfidenceLevel(
      score
    );


  const status =
    getConfidenceStatus(
      input,
      score
    );


  return {

    score,

    level,

    status,

    breakdown: {

      base,

      mx,

      smtp,

      mailbox,

      catchAll,

      provider,

      pattern,

    patternIntelligence,


      retry,

      responseCode,

      total:
        score

    }

  };
}

/*
==================================================
LEGACY COMPATIBILITY
==================================================
*/

export function calculateConfidence(
  totalScore: number
): {
  score: number;
  level: ConfidenceLevel;
  status:
    | "VERIFIED"
    | "LIKELY_VALID"
    | "UNCERTAIN"
    | "INVALID";
} {

  const score =
    Math.round(
      clamp(totalScore) * 100
    ) / 100;

  return {

    score,

    level:
      getConfidenceLevel(
        score
      ),

    status:
      score >= 80
        ? "VERIFIED"
        : score >= 60
          ? "LIKELY_VALID"
          : score < 30
            ? "INVALID"
            : "UNCERTAIN"

  };
}