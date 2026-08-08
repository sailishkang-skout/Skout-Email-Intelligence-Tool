import {
  type EmailPermutationCandidate
} from "./emailPermutationEngine.js";

import {
  getPatternHistory
} from "./patternHistory.js";

import {
  getPatternIntelligence
} from "./patternIntelligence.js";

/*
==================================================
PATTERN RANKER
==================================================

Responsibilities:

1. Accept generated email candidates.
2. Normalize candidate/domain data.
3. Read persistent pattern history.
4. Read pattern intelligence.
5. Combine historical evidence with deterministic
   ranking.
6. Return ranked candidates.
7. Never perform SMTP verification.
8. Never write pattern history.

Pattern learning happens elsewhere:

SMTP verification
      ↓
pattern observation
      ↓
pattern history
      ↓
pattern intelligence
      ↓
pattern ranker
==================================================
*/

export type PatternDecision =
  | "STRONG"
  | "GOOD"
  | "UNKNOWN"
  | "WEAK"
  | "REJECT";

export interface RankedEmailCandidate {
  email: string;
  pattern: string;

  originalRank: number;
  finalScore: number;

  decision: PatternDecision;
  confidence: number;

  attempts: number;
  successes: number;
  failures: number;

  historicalSuccessRate: number;

  reasons: string[];
}

export interface RankedEmailResult {
  domain: string;

  candidates: RankedEmailCandidate[];

  recommended:
    RankedEmailCandidate | null;
}

/*
==================================================
DEFAULT PATTERN PRIORITY
==================================================

Used only when there is insufficient historical
evidence.

Higher score = stronger deterministic prior.
==================================================
*/

const DEFAULT_PATTERN_PRIORITIES: Record<
  string,
  number
> = {
  "first@domain": 10,
  "last@domain": 9.52,
  "first.last@domain": 9.05,
  "firstlast@domain": 8.57,
  "first_last@domain": 8.10,
  "first-last@domain": 7.62,
  "flast@domain": 7.14,
  "f.last@domain": 6.67,
  "f_last@domain": 6.19,
  "f-last@domain": 5.71,
  "firstl@domain": 5.24,
  "first.l@domain": 4.76,
  "first_l@domain": 4.29,
  "first-l@domain": 3.81,
  "fl@domain": 3.33,
  "f.l@domain": 2.86,
  "f_l@domain": 2.38,
  "f-l@domain": 1.90,
  "last.first@domain": 1.43,
  "lastfirst@domain": 0.95,
  "last_first@domain": 0.48,
  "last-first@domain": 0
};

/*
==================================================
NORMALIZATION
==================================================
*/

function normalizeDomain(
  domain: string
): string {
  const normalized =
    domain
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
      ?.trim();

  if (!normalized) {
    throw new Error(
      "Invalid domain"
    );
  }

  return normalized;
}

function normalizePattern(
  pattern: string
): string {
  return pattern
    .trim()
    .toLowerCase();
}

/*
==================================================
PATTERN PRIORITY
==================================================
*/

function getDefaultPriority(
  pattern: string,
  originalRank: number
): number {
  const normalizedPattern =
    normalizePattern(pattern);

  const configured =
    DEFAULT_PATTERN_PRIORITIES[
      normalizedPattern
    ];

  if (
    typeof configured === "number"
  ) {
    return configured;
  }

  /*
  Unknown patterns receive a deterministic
  decreasing score based on their original rank.
  */

  return Math.max(
    0,
    10 - (
      Math.max(
        originalRank,
        1
      ) - 1
    ) * 0.45
  );
}

/*
==================================================
HISTORICAL SUCCESS RATE
==================================================
*/

function calculateHistoricalSuccessRate(
  successes: number,
  failures: number
): number {
  const attempts =
    successes +
    failures;

  if (attempts <= 0) {
    return 0;
  }

  return Number(
    (
      successes /
      attempts
    ).toFixed(4)
  );
}

/*
==================================================
DECISION
==================================================
*/

function determineDecision(
  attempts: number,
  successes: number,
  failures: number,
  confidence: number
): PatternDecision {

  /*
  No evidence means UNKNOWN.

  This is important because a newly observed
  pattern must not be treated as successful
  merely because it has a high default ranking.
  */

  if (
    attempts <= 0
  ) {
    return "UNKNOWN";
  }

  if (
    successes >= 3 &&
    confidence >= 85
  ) {
    return "STRONG";
  }

  if (
    successes >= 1 &&
    confidence >= 70
  ) {
    return "GOOD";
  }

  if (
    failures >= 3 &&
    confidence <= 35
  ) {
    return "REJECT";
  }

  if (
    failures > successes &&
    confidence < 50
  ) {
    return "WEAK";
  }

  return "UNKNOWN";
}

/*
==================================================
HISTORICAL SCORE
==================================================
*/

function calculateHistoricalScore(
  attempts: number,
  successes: number,
  failures: number,
  confidence: number
): number {

  if (
    attempts <= 0
  ) {
    return 0;
  }

  const successRate =
    calculateHistoricalSuccessRate(
      successes,
      failures
    );

  /*
  Historical evidence becomes increasingly
  important as observations accumulate.

  Maximum historical contribution = 5 points.
  */

  const evidenceWeight =
    Math.min(
      attempts / 5,
      1
    );

  const confidenceFactor =
    confidence / 100;

  const rateFactor =
    successRate;

  return (
    (
      rateFactor * 0.60 +
      confidenceFactor * 0.40
    ) *
    5 *
    evidenceWeight
  );
}

/*
==================================================
PATTERN INTELLIGENCE SCORE
==================================================
*/

async function getIntelligenceScore(
  domain: string,
  pattern: string
): Promise<number | null> {

  try {

    const intelligence =
      await getPatternIntelligence(
        domain
      );

    const normalizedPattern =
      normalizePattern(
        pattern
      );

    const matchingPattern =
      intelligence.patterns.find(
        (
          record
        ) =>
          normalizePattern(
            record.pattern
          ) === normalizedPattern
      );

    if (
      !matchingPattern
    ) {

      return null;

    }

    /*
    ------------------------------------------------
    INTELLIGENCE SCORE

    Pattern intelligence does not expose a single
    "score" property.

    We combine the actual intelligence dimensions:

      historicalConfidence
      sampleStrength
      recencyScore
      reliabilityScore

    Each value is normalized to 0-100 before
    contributing to the ranker.
    ------------------------------------------------
    */

    const historicalConfidence =
      Number(
        matchingPattern.historicalConfidence
      ) || 0;

    const sampleStrength =
      Number(
        matchingPattern.sampleStrength
      ) || 0;

    const recencyScore =
      Number(
        matchingPattern.recencyScore
      ) || 0;

    const reliabilityScore =
      Number(
        matchingPattern.reliabilityScore
      ) || 0;

    /*
    Weighted intelligence score.

    Historical confidence:
      40%

    Reliability:
      30%

    Sample strength:
      20%

    Recency:
      10%
    */

    const score =
      (
        historicalConfidence * 0.40
      ) +
      (
        reliabilityScore * 0.30
      ) +
      (
        sampleStrength * 0.20
      ) +
      (
        recencyScore * 0.10
      );

    return Number(
      Math.max(
        0,
        Math.min(
          100,
          score
        )
      ).toFixed(2)
    );

  } catch {

    return null;

  }

}

/*
==================================================
REASONS
==================================================
*/

function buildReasons(
  pattern: string,
  originalRank: number,
  attempts: number,
  successes: number,
  failures: number,
  confidence: number,
  intelligenceScore: number | null
): string[] {

  const reasons: string[] = [];

  if (
    attempts === 0
  ) {

    reasons.push(
      "No historical observations for this pattern"
    );

  } else {

    reasons.push(
      `${successes} successful historical observation(s)`
    );

    if (
      failures > 0
    ) {

      reasons.push(
        `${failures} failed historical observation(s)`
      );

    }

    reasons.push(
      `${confidence}% historical confidence`
    );

  }

  const defaultPriority =
    getDefaultPriority(
      pattern,
      originalRank
    );

  reasons.push(
    `Deterministic pattern priority ${defaultPriority.toFixed(2)}`
  );

  if (
    intelligenceScore !== null
  ) {

    reasons.push(
      `Pattern intelligence score ${intelligenceScore.toFixed(2)}`
    );

  }

  return reasons;
}

/*
==================================================
RANK ONE CANDIDATE
==================================================
*/

async function rankCandidate(
  domain: string,
  candidate: EmailPermutationCandidate
): Promise<RankedEmailCandidate> {

  const pattern =
    normalizePattern(
      candidate.pattern
    );

  const email =
    candidate.email
      .trim()
      .toLowerCase();

  /*
  ------------------------------------------------
  HISTORY
  ------------------------------------------------
  */

  const history =
    await getPatternHistory(
      domain,
      pattern
    );

  const attempts =
    history?.attempts ??
    0;

  const successes =
    history?.successes ??
    0;

  const failures =
    history?.failures ??
    0;

  const confidence =
    history?.confidence ??
    0;

  const historicalSuccessRate =
    calculateHistoricalSuccessRate(
      successes,
      failures
    );

  /*
  ------------------------------------------------
  DEFAULT PRIOR
  ------------------------------------------------
  */

  const defaultPriority =
    getDefaultPriority(
      pattern,
      candidate.rank
    );

  /*
  ------------------------------------------------
  HISTORICAL EVIDENCE
  ------------------------------------------------
  */

  const historicalScore =
    calculateHistoricalScore(
      attempts,
      successes,
      failures,
      confidence
    );

  /*
  ------------------------------------------------
  PATTERN INTELLIGENCE
  ------------------------------------------------
  */

  const intelligenceScore =
    await getIntelligenceScore(
      domain,
      pattern
    );

  /*
  ------------------------------------------------
  INTELLIGENCE CONTRIBUTION
  ------------------------------------------------
  */

  const intelligenceContribution =
    intelligenceScore === null
      ? 0
      : Math.min(
          Math.max(
            intelligenceScore,
            0
          ),
          100
        ) / 100 * 3;

  /*
  ------------------------------------------------
  FINAL SCORE
  ------------------------------------------------

  Deterministic prior:
      0 - 10

  Historical evidence:
      0 - 5

  Intelligence:
      0 - 3

  Total:
      0 - 18
  ------------------------------------------------
  */

  const finalScore =
    Number(
      (
        defaultPriority +
        historicalScore +
        intelligenceContribution
      ).toFixed(2)
    );

  const decision =
    determineDecision(
      attempts,
      successes,
      failures,
      confidence
    );

  const reasons =
    buildReasons(
      pattern,
      candidate.rank,
      attempts,
      successes,
      failures,
      confidence,
      intelligenceScore
    );

  return {

    email,

    pattern,

    originalRank:
      candidate.rank,

    finalScore,

    decision,

    confidence,

    attempts,

    successes,

    failures,

    historicalSuccessRate,

    reasons

  };
}

/*
==================================================
PUBLIC
==================================================
*/

export async function rankEmailCandidates(
  domain: string,
  candidates: EmailPermutationCandidate[]
): Promise<RankedEmailResult> {

  const normalizedDomain =
    normalizeDomain(
      domain
    );

  if (
    !Array.isArray(candidates)
  ) {

    throw new Error(
      "Candidates must be an array"
    );

  }

  const ranked =
    await Promise.all(
      candidates
        .filter(
          (
            candidate
          ) =>
            Boolean(
              candidate &&
              typeof candidate.email === "string" &&
              typeof candidate.pattern === "string"
            )
        )
        .map(
          (
            candidate
          ) =>
            rankCandidate(
              normalizedDomain,
              candidate
            )
        )
    );

  /*
  ------------------------------------------------
  SORT
  ------------------------------------------------

  1. STRONG
  2. GOOD
  3. UNKNOWN
  4. WEAK
  5. REJECT

  Then final score.
  Then original rank.
  ------------------------------------------------
  */

  const decisionWeight:
    Record<PatternDecision, number> = {
      STRONG: 5,
      GOOD: 4,
      UNKNOWN: 3,
      WEAK: 2,
      REJECT: 1
    };

  ranked.sort(
    (
      a,
      b
    ) => {

      const decisionDifference =
        decisionWeight[b.decision] -
        decisionWeight[a.decision];

      if (
        decisionDifference !== 0
      ) {

        return decisionDifference;

      }

      if (
        b.finalScore !==
        a.finalScore
      ) {

        return (
          b.finalScore -
          a.finalScore
        );

      }

      return (
        a.originalRank -
        b.originalRank
      );

    }
  );

  /*
  ------------------------------------------------
  RECOMMENDATION
  ------------------------------------------------
  */

  const recommended =
    ranked.find(
      (
        candidate
      ) =>
        candidate.decision === "STRONG"
    ) ??
    ranked.find(
      (
        candidate
      ) =>
        candidate.decision === "GOOD"
    ) ??
    ranked.find(
      (
        candidate
      ) =>
        candidate.decision !== "REJECT"
    ) ??
    null;

  return {

    domain:
      normalizedDomain,

    candidates:
      ranked,

    recommended

  };

}

/*
==================================================
ALIAS
==================================================
*/

export async function rankPatterns(
  domain: string,
  candidates: EmailPermutationCandidate[]
): Promise<RankedEmailResult> {

  return rankEmailCandidates(
    domain,
    candidates
  );

}
