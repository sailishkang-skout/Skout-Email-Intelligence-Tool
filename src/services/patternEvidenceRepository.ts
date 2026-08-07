import {
  getPatternHistory
} from "./patternHistory.js";

/*
==================================================
PATTERN EVIDENCE REPOSITORY
==================================================

Purpose:

Read historical pattern observations.

Architecture:

Evidence Ledger
    ↓
Verification Attempt History
    ↓
Pattern History
    ↓
Pattern Evidence Repository
    ↓
Confidence Engine
    ↓
Recommendation Engine

This repository:

- reads pattern history
- normalizes the result
- calculates historical success rate

It does NOT:

- perform SMTP verification
- perform catch-all checks
- modify pattern history
- calculate final email confidence
- recommend an email
==================================================
*/

export interface PatternHistoricalEvidence {
  domain: string;
  pattern: string;
  attempts: number;
  successes: number;
  failures: number;
  successRate: number | null;
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
SAFE COUNTER
==================================================
*/

function safeCounter(
  value: unknown
): number {

  if (
    typeof value !== "number"
  ) {
    return 0;
  }

  if (
    !Number.isFinite(value)
  ) {
    return 0;
  }

  if (
    value < 0
  ) {
    return 0;
  }

  return value;

}

/*
==================================================
CALCULATE SUCCESS RATE
==================================================
*/

function calculateSuccessRate(
  attempts: number,
  successes: number
): number | null {

  if (
    attempts <= 0
  ) {
    return null;
  }

  return Math.max(
    0,
    Math.min(
      1,
      successes / attempts
    )
  );

}

/*
==================================================
GET PATTERN HISTORICAL EVIDENCE
==================================================
*/

export async function getPatternHistoricalEvidence(
  domain: string,
  pattern: string
): Promise<PatternHistoricalEvidence> {

  const normalizedDomain =
    normalizeDomain(
      domain
    );

  const normalizedPattern =
    normalizePattern(
      pattern
    );

  if (
    !normalizedDomain
  ) {

    throw new Error(
      "domain is required"
    );

  }

  if (
    !normalizedPattern
  ) {

    throw new Error(
      "pattern is required"
    );

  }

  let history:
    Awaited<
      ReturnType<typeof getPatternHistory>
    > = null;

  try {

    history =
      await getPatternHistory(
        normalizedDomain,
        normalizedPattern
      );

  } catch {

    /*
    Pattern history is supporting evidence.

    A history-read failure must not break
    the primary email verification pipeline.

    Therefore return zero historical evidence.
    */

    return {

      domain:
        normalizedDomain,

      pattern:
        normalizedPattern,

      attempts:
        0,

      successes:
        0,

      failures:
        0,

      successRate:
        null

    };

  }

  /*
  ==================================================
  NO HISTORY
  ==================================================
  */

  if (
    !history
  ) {

    return {

      domain:
        normalizedDomain,

      pattern:
        normalizedPattern,

      attempts:
        0,

      successes:
        0,

      failures:
        0,

      successRate:
        null

    };

  }

  /*
  ==================================================
  NORMALIZE HISTORY
  ==================================================
  */

  const attempts =
    safeCounter(
      history.attempts
    );

  const successes =
    safeCounter(
      history.successes
    );

  const failures =
    safeCounter(
      history.failures
    );

  /*
  ==================================================
  SUCCESS RATE
  ==================================================
  */

  const successRate =
    calculateSuccessRate(
      attempts,
      successes
    );

  /*
  ==================================================
  RETURN
  ==================================================
  */

  return {

    domain:
      normalizedDomain,

    pattern:
      normalizedPattern,

    attempts,

    successes,

    failures,

    successRate

  };

}

/*
==================================================
COMPATIBILITY ALIAS
==================================================

Provides a stable repository-level API for
services that want pattern evidence.

==================================================
*/

export async function getPatternEvidence(
  domain: string,
  pattern: string
): Promise<PatternHistoricalEvidence> {

  return getPatternHistoricalEvidence(
    domain,
    pattern
  );

}