import { getDatabase } from "../database/database.js";

/*
==================================================
PATTERN INTELLIGENCE ENGINE
==================================================

Purpose:

Convert historical pattern evidence into a
decision-ready intelligence signal.

This service is READ ONLY.

It does NOT:

- record observations
- modify pattern_history
- modify pattern_observations
- perform SMTP verification
- generate email candidates

It ONLY analyzes persisted evidence.

Architecture:

pattern_history
       +
pattern_observations
       ↓
Pattern Intelligence
       ↓
reliability
sample strength
recency
success rate
       ↓
classification
       ↓
recommendation
       ↓
candidate ranking

==================================================
*/

/*
==================================================
DATABASE
==================================================

Uses the shared application database connection
rather than opening a second connection to the
same file. A second raw connection would bypass
the shared WAL/busy_timeout configuration and risk
lock contention under load.
==================================================
*/

const db = getDatabase();

/*
==================================================
TYPES
==================================================
*/

export type PatternClassification =
  | "HIGH_CONFIDENCE"
  | "MEDIUM_CONFIDENCE"
  | "LOW_CONFIDENCE"
  | "INSUFFICIENT_DATA";

export type PatternRecommendation =
  | "PREFER"
  | "ALLOW"
  | "AVOID"
  | "INSUFFICIENT_DATA";

  export type PatternRiskLevel =
  | "VERY_LOW"
  | "LOW"
  | "MEDIUM"
  | "HIGH"
  | "CRITICAL";

  export type PatternTrend =
  | "IMPROVING"
  | "STABLE"
  | "DECLINING"
  | "UNKNOWN";

export interface PatternIntelligenceRecord {
  domain: string;
  pattern: string;

  attempts: number;
  successes: number;
  failures: number;

  successRate: number;

  historicalConfidence: number;

  sampleStrength: number;

  recencyScore: number;

  reliabilityScore: number;


  competitiveAdvantage: number;

  

/*
Difference from the strongest competing
pattern for this domain.
*/

domainRank: number;

/*
1 = strongest pattern
*/

  bayesianConfidence: number;

  wilsonScore: number;

stabilityScore: number;

  trend: PatternTrend;

  riskLevel: PatternRiskLevel;

  classification: PatternClassification;

  recommendation: PatternRecommendation;

  firstSeenAt: string;
  lastSeenAt: string;
}

export interface PatternIntelligenceResult {
  domain: string;

  patterns: PatternIntelligenceRecord[];

  bestPattern: PatternIntelligenceRecord | null;

  hasReliablePattern: boolean;

  generatedAt: string;
}

/*
==================================================
INTERNAL DATABASE TYPES
==================================================
*/

interface PatternHistoryRow {
  domain: string;
  pattern: string;

  attempts: number;
  successes: number;
  failures: number;

  confidence: number;

  firstSeenAt: string;
  lastSeenAt: string;
}

interface ObservationAggregateRow {
  domain: string;
  pattern: string;

  observationCount: number;
  successfulObservations: number;
  failedObservations: number;

  latestObservedAt: string;
}

/*
==================================================
CONSTANTS
==================================================
*/

/*
Maximum useful sample size.

Once a pattern has 20 observations, additional
observations still matter to the database but
sample-strength contribution is considered
fully saturated.
*/

const MAX_SAMPLE_SIZE = 20;

/*
Pattern confidence weighting.

Historical confidence:
    40%

Success rate:
    30%

Sample strength:
    20%

Recency:
    10%

This deliberately prevents a pattern with
one successful observation from becoming
immediately dominant.
*/

const HISTORICAL_CONFIDENCE_WEIGHT = 0.40;

const SUCCESS_RATE_WEIGHT = 0.30;

const SAMPLE_STRENGTH_WEIGHT = 0.20;

const RECENCY_WEIGHT = 0.10;

/*
Classification thresholds.

These are intentionally conservative.
*/

const HIGH_CONFIDENCE_THRESHOLD = 80;

const MEDIUM_CONFIDENCE_THRESHOLD = 60;

const LOW_CONFIDENCE_THRESHOLD = 40;

/*
Minimum evidence requirements.

A pattern cannot become HIGH_CONFIDENCE
from a single observation.

*/

const HIGH_CONFIDENCE_MIN_ATTEMPTS = 3;

const MEDIUM_CONFIDENCE_MIN_ATTEMPTS = 2;

/*
Recommendation thresholds.
*/

const PREFER_THRESHOLD = 80;

const ALLOW_THRESHOLD = 60;

const AVOID_THRESHOLD = 40;

/*
Recency decay.

180 days is the half-life.

This means:

0 days old:
    100

180 days old:
    approximately 50

360 days old:
    approximately 25

This allows older evidence to remain useful
without dominating forever.
*/

const RECENCY_HALF_LIFE_DAYS = 180;

/*
==================================================
NORMALIZATION
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

function normalizePattern(
  pattern: string
): string {

  return pattern
    .trim()
    .toLowerCase();

}

/*
==================================================
NUMBER HELPERS
==================================================
*/

function clamp(
  value: number,
  min: number,
  max: number
): number {

  return Math.min(
    max,
    Math.max(
      min,
      value
    )
  );

}

function round(
  value: number,
  decimals = 2
): number {

  const multiplier =
    10 ** decimals;

  return (
    Math.round(
      value * multiplier
    ) /
    multiplier
  );

}

/*
==================================================
SUCCESS RATE
==================================================
*/

function calculateSuccessRate(
  attempts: number,
  successes: number
): number {

  if (
    attempts <= 0
  ) {

    return 0;

  }

  return clamp(
    successes / attempts,
    0,
    1
  );

}

/*
==================================================
SAMPLE STRENGTH
==================================================
*/

/*
Uses a square-root curve.

Why?

Moving from:

1 → 2 observations

should matter substantially.

Moving from:

19 → 20 observations

should matter much less.

This avoids linear over-weighting of very
large datasets.
*/

function calculateSampleStrength(
  attempts: number
): number {

  if (
    attempts <= 0
  ) {

    return 0;

  }

  const normalized =
    Math.min(
      attempts,
      MAX_SAMPLE_SIZE
    ) /
    MAX_SAMPLE_SIZE;

  return clamp(
    Math.sqrt(
      normalized
    ) * 100,
    0,
    100
  );

}

/*
==================================================
RECENCY
==================================================
*/

function calculateRecencyScore(
  lastSeenAt: string
): number {

  const timestamp =
    Date.parse(
      lastSeenAt
    );

  if (
    Number.isNaN(timestamp)
  ) {

    return 0;

  }

  const ageMs =
    Math.max(
      0,
      Date.now() - timestamp
    );

  const ageDays =
    ageMs /
    (
      1000 *
      60 *
      60 *
      24
    );

  const decay =
    Math.pow(
      0.5,
      ageDays /
      RECENCY_HALF_LIFE_DAYS
    );

  return clamp(
    decay * 100,
    0,
    100
  );

}

/*
==================================================
BAYESIAN CONFIDENCE
==================================================

Purpose:

Adjust pattern confidence based on:

- successes
- failures
- sample size

Prevents:

1/1 success = 100% confidence

Small samples receive uncertainty penalty.

==================================================
*/

function calculateBayesianConfidence(
  successes: number,
  failures: number
): number {

  const total =
    successes + failures;


  /*
  Prior:

  Assume unknown patterns start
  with neutral probability.

  Beta(1,1)
  */

  const alpha =
    successes + 1;


  const beta =
    failures + 1;


  const probability =
    alpha /
    (
      alpha + beta
    );


  /*
  Sample confidence.

  More observations =
  more trust.

  Saturates around 50 samples.
  */

  const sampleWeight =
    Math.min(
      1,
      Math.sqrt(
        total / 50
      )
    );


  const confidence =
    (
      probability *
      sampleWeight
    )
    *
    100;


  return round(
    clamp(
      confidence,
      0,
      100
    )
  );

}

/*
==================================================
WILSON SCORE
==================================================

Purpose:

Ranking adjustment for small datasets.

Prevents tiny samples from dominating.

Example:

1/1 success
will rank below

100/100 success

==================================================
*/

function calculateWilsonScore(
  successes: number,
  failures: number
): number {

  const total =
    successes + failures;


  if (
    total === 0
  ) {

    return 0;

  }


  const z = 1.96;


  const proportion =
    successes / total;


  const denominator =
    1 +
    (
      z * z
    ) /
    total;


  const centre =
    proportion +
    (
      z * z
    ) /
    (
      2 * total
    );


  const margin =
    z *
    Math.sqrt(
      (
        proportion *
        (
          1 - proportion
        )
        +
        (
          z * z
        ) /
        (
          4 * total
        )
      )
      /
      total
    );


  const lowerBound =
    (
      centre -
      margin
    )
    /
    denominator;


  return round(
    clamp(
      lowerBound * 100,
      0,
      100
    )
  );

}

/*
==================================================
PATTERN STABILITY
==================================================

Measures consistency of a pattern.

Higher =
same performance over time

Lower =
volatile behavior

==================================================
*/

function calculateStabilityScore(
  successes: number,
  failures: number
): number {

  const total =
    successes + failures;


  if (
    total === 0
  ) {

    return 0;

  }


  const successRate =
    successes /
    total;


  /*
  Penalize instability.

  A perfect pattern receives
  a high stability score.

  */

  const stability =
    (
      successRate *
      100
    )
    *
    Math.min(
      1,
      Math.sqrt(
        total / 20
      )
    );


  return round(
    clamp(
      stability,
      0,
      100
    )
  );

}

/*
==================================================
PATTERN TREND
==================================================

Determines direction.

Future versions can use
time buckets.

Current version uses
confidence movement.

==================================================
*/

function calculatePatternTrend(
  reliabilityScore: number,
  stabilityScore: number
): PatternTrend {


  if (
    reliabilityScore === 0
  ) {

    return "UNKNOWN";

  }


  if (
    stabilityScore >= 80 &&
    reliabilityScore >= 70
  ) {

    return "STABLE";

  }


  if (
    stabilityScore >= 60 &&
    reliabilityScore < 60
  ) {

    return "IMPROVING";

  }


  if (
    stabilityScore < 40
  ) {

    return "DECLINING";

  }


  return "STABLE";

}

/*
==================================================
RELIABILITY SCORE
==================================================
*/

function calculateReliabilityScore(
  historicalConfidence: number,
  successRate: number,
  sampleStrength: number,
  recencyScore: number
): number {

  const score =
    (
      historicalConfidence *
      HISTORICAL_CONFIDENCE_WEIGHT
    ) +
    (
      successRate *
      100 *
      SUCCESS_RATE_WEIGHT
    ) +
    (
      sampleStrength *
      SAMPLE_STRENGTH_WEIGHT
    ) +
    (
      recencyScore *
      RECENCY_WEIGHT
    );

  return round(
  clamp(
    score,
    0,
    100
  )
);

}

  function calculateRiskLevel(
  reliabilityScore: number,
  attempts: number,
  successRate: number
): PatternRiskLevel {

  /*
  No evidence
  */
  if (
    attempts === 0
  ) {
    return "CRITICAL";
  }


  /*
  Strong proven pattern
  */
  if (
    reliabilityScore >= 80 &&
    successRate >= 0.9 &&
    attempts >= 5
  ) {
    return "VERY_LOW";
  }


  /*
  Usable but monitor
  */
  if (
    reliabilityScore >= 60
  ) {
    return "MEDIUM";
  }


  /*
  Weak evidence
  */
  if (
    reliabilityScore >= 40
  ) {
    return "HIGH";
  }


  return "CRITICAL";
}

/*
==================================================
CLASSIFICATION
==================================================
*/

function classifyPattern(
  reliabilityScore: number,
  attempts: number,
  successes: number
): PatternClassification {

  if (
    attempts <= 0
  ) {

    return "INSUFFICIENT_DATA";

  }

  /*
  Never call a pattern high confidence
  from fewer than three observations.
  */

  if (
    reliabilityScore >=
      HIGH_CONFIDENCE_THRESHOLD &&
    attempts >=
      HIGH_CONFIDENCE_MIN_ATTEMPTS &&
    successes > 0
  ) {

    return "HIGH_CONFIDENCE";

  }

  if (
    reliabilityScore >=
      MEDIUM_CONFIDENCE_THRESHOLD &&
    attempts >=
      MEDIUM_CONFIDENCE_MIN_ATTEMPTS
  ) {

    return "MEDIUM_CONFIDENCE";

  }

  if (
    reliabilityScore >=
      LOW_CONFIDENCE_THRESHOLD
  ) {

    return "LOW_CONFIDENCE";

  }

  return "INSUFFICIENT_DATA";

}

/*
==================================================
RECOMMENDATION
==================================================
*/

function calculateRecommendation(
  reliabilityScore: number,
  classification: PatternClassification,
  successRate: number,
  failures: number
): PatternRecommendation {

  /*
  Never recommend a pattern that has never
  succeeded.
  */

  if (
    successRate <= 0 ||
    failures > 0 &&
    successRate < 0.5
  ) {

    return "AVOID";

  }

  if (
    classification ===
    "INSUFFICIENT_DATA"
  ) {

    return "INSUFFICIENT_DATA";

  }

  if (
    reliabilityScore >=
    PREFER_THRESHOLD
  ) {

    return "PREFER";

  }

  if (
    reliabilityScore >=
    ALLOW_THRESHOLD
  ) {

    return "ALLOW";

  }

  if (
    reliabilityScore >=
    AVOID_THRESHOLD
  ) {

    return "ALLOW";

  }

  return "AVOID";

}

/*
==================================================
DATABASE QUERIES
==================================================
*/

async function queryPatternsForDomain(
  domain: string
): Promise<PatternHistoryRow[]> {

  const result =
    await db.query(
      `
      SELECT
        domain,
        pattern,
        attempts,
        successes,
        failures,
        confidence,
        first_seen_at AS "firstSeenAt",
        last_seen_at AS "lastSeenAt"

      FROM pattern_history

      WHERE domain = $1

      ORDER BY
        confidence DESC,
        successes DESC,
        attempts DESC
      `,
      [domain]
    );

  return result.rows.map(normalizeHistoryRow);

}

async function queryObservationAggregatesForDomain(
  domain: string
): Promise<ObservationAggregateRow[]> {

  const result =
    await db.query(
      `
      SELECT
        domain,
        pattern,
        COUNT(*) AS "observationCount",
        SUM(
          CASE WHEN outcome = 'SUCCESS' THEN 1 ELSE 0 END
        ) AS "successfulObservations",
        SUM(
          CASE WHEN outcome = 'FAILURE' THEN 1 ELSE 0 END
        ) AS "failedObservations",
        MAX(observed_at) AS "latestObservedAt"

      FROM pattern_observations

      WHERE domain = $1

      GROUP BY domain, pattern
      `,
      [domain]
    );

  return result.rows.map(row => ({

    ...row,

    observationCount: Number(row.observationCount),

    successfulObservations: Number(row.successfulObservations),

    failedObservations: Number(row.failedObservations),

    latestObservedAt:
      row.latestObservedAt instanceof Date
        ? row.latestObservedAt.toISOString()
        : row.latestObservedAt,

  }));

}

async function queryPatternHistory(
  domain: string,
  pattern: string
): Promise<PatternHistoryRow | undefined> {

  const result =
    await db.query(
      `
      SELECT
        domain,
        pattern,
        attempts,
        successes,
        failures,
        confidence,
        first_seen_at AS "firstSeenAt",
        last_seen_at AS "lastSeenAt"

      FROM pattern_history

      WHERE domain = $1
        AND pattern = $2
      `,
      [domain, pattern]
    );

  const row = result.rows[0];

  return row ? normalizeHistoryRow(row) : undefined;

}

function normalizeHistoryRow(
  row: Record<string, unknown>
): PatternHistoryRow {

  const firstSeenAt = row.firstSeenAt;
  const lastSeenAt = row.lastSeenAt;

  return {

    ...row,

    firstSeenAt:
      firstSeenAt instanceof Date
        ? firstSeenAt.toISOString()
        : String(firstSeenAt),

    lastSeenAt:
      lastSeenAt instanceof Date
        ? lastSeenAt.toISOString()
        : String(lastSeenAt),

  } as PatternHistoryRow;

}

/*
==================================================
OBSERVATION AGGREGATES
==================================================
*/

async function loadObservationAggregates(
  domain: string
): Promise<Map<
  string,
  ObservationAggregateRow
>> {

  const rows =
    await queryObservationAggregatesForDomain(
      domain
    );

  const result =
    new Map<
      string,
      ObservationAggregateRow
    >();

  for (
    const row of rows
  ) {

    result.set(
      normalizePattern(
        row.pattern
      ),
      row
    );

  }

  return result;

}



/*
==================================================
BUILD INTELLIGENCE RECORD
==================================================
*/

function buildIntelligenceRecord(
  history: PatternHistoryRow,
  observation?: ObservationAggregateRow
): PatternIntelligenceRecord {

  /*
  Prefer persisted history counters because
  those counters are the canonical aggregate
  maintained by patternHistory.ts.
  */

  const attempts =
    Math.max(
      0,
      Number(
        history.attempts
      )
    );

  const successes =
    Math.max(
      0,
      Number(
        history.successes
      )
    );

  const failures =
    Math.max(
      0,
      Number(
        history.failures
      )
    );

  const historicalConfidence =
    clamp(
      Number(
        history.confidence
      ) || 0,
      0,
      100
    );


  /*
  Use observation data as a consistency check.

  We do not overwrite history counters here.
  */

  const observationCount =
    observation
      ? Number(
          observation.observationCount
        )
      : attempts;

  const effectiveAttempts =
    Math.max(
      attempts,
      observationCount
    );

  const effectiveSuccesses =
    Math.max(
      successes,
      observation
        ? Number(
            observation.successfulObservations
          )
        : successes
    );

  const successRate =
    calculateSuccessRate(
      effectiveAttempts,
      effectiveSuccesses
    );

  const sampleStrength =
    calculateSampleStrength(
      effectiveAttempts
    );

  /*
  Last seen timestamp from history is canonical.
  Observation aggregate is only a fallback.
  */

  const lastSeenAt =
    history.lastSeenAt ||
    observation?.latestObservedAt ||
    new Date(
      0
    ).toISOString();

  const recencyScore =
    calculateRecencyScore(
      lastSeenAt
    );

  const reliabilityScore =
  calculateReliabilityScore(
    historicalConfidence,
    successRate,
    sampleStrength,
    recencyScore
  );

  const bayesianConfidence =
  calculateBayesianConfidence(
    effectiveSuccesses,
    failures
  );

  const wilsonScore =
  calculateWilsonScore(
    effectiveSuccesses,
    failures
  );

const stabilityScore =
  calculateStabilityScore(
    effectiveSuccesses,
    failures
  );


const trend =
  calculatePatternTrend(
    reliabilityScore,
    stabilityScore
  );

  const classification =
  classifyPattern(
    reliabilityScore,
    effectiveAttempts,
    effectiveSuccesses
  );

const recommendation =
  calculateRecommendation(
    reliabilityScore,
    classification,
    successRate,
    failures
  );

  return {

  domain:
    history.domain,

  pattern:
    history.pattern,

  attempts:
    effectiveAttempts,

  successes:
    effectiveSuccesses,

  failures,

  successRate:
    round(
      successRate,
      4
    ),

  historicalConfidence:
    round(
      historicalConfidence
    ),

  sampleStrength:
    round(
      sampleStrength
    ),

  recencyScore:
    round(
      recencyScore
    ),

  reliabilityScore,

  riskLevel:
    calculateRiskLevel(
      reliabilityScore,
      effectiveAttempts,
      successRate
    ),
 competitiveAdvantage:
    0,

  domainRank:
    0,

 bayesianConfidence:
  bayesianConfidence,

  wilsonScore:
  wilsonScore,

  stabilityScore:
  stabilityScore,

trend:
  trend,

  classification,

  recommendation,

  firstSeenAt:
    history.firstSeenAt,

  lastSeenAt

};

}


/*
==================================================
COMPETITIVE ADVANTAGE
==================================================

Measures how much stronger a pattern is
compared with competing patterns inside
the same domain.

==================================================
*/

function calculateCompetitiveAdvantage(
  current: PatternIntelligenceRecord,
  allPatterns: PatternIntelligenceRecord[]
): number {

  if (
    allPatterns.length <= 1
  ) {
    return 100;
  }


  const competitors =
    allPatterns.filter(
      pattern =>
        pattern.pattern !== current.pattern
    );


  if (
    competitors.length === 0
  ) {
    return 100;
  }


  const strongestCompetitor =
    competitors.reduce(
      (
        strongest,
        candidate
      ) => {

        return candidate.reliabilityScore >
          strongest.reliabilityScore

          ? candidate

          : strongest;

      }
    );


  const difference =
    current.reliabilityScore -
    strongestCompetitor.reliabilityScore;


  return round(
    clamp(
      50 + difference,
      0,
      100
    )
  );

}

/*
==================================================
RANKING
==================================================
*/

function rankingScore(
  record: PatternIntelligenceRecord
): number {

  /*
  Ranking favors:

  1. reliability
  2. successful observations
  3. success rate
  4. fewer failures

  This prevents a pattern with enormous
  sample volume but poor success rate from
  automatically winning.
  */

  const reliability =
    record.reliabilityScore;

  const successRate =
    record.successRate *
    100;

  const successBonus =
    Math.min(
      record.successes,
      20
    ) *
    0.5;

  const failurePenalty =
    Math.min(
      record.failures,
      20
    ) *
    1.5;

  return (
    reliability * 0.70
    +
    successRate * 0.25
    +
    successBonus
    -
    failurePenalty
  );

}

function assignPatternRankingMetadata(
  patterns: PatternIntelligenceRecord[]
): PatternIntelligenceRecord[] {

  if (
    patterns.length === 0
  ) {
    return [];
  }


  const ranked =
    [...patterns].sort(
      (
        a,
        b
      ) =>
        rankingScore(b) -
        rankingScore(a)
    );


  return ranked.map(
    (
      pattern,
      index
    ) => {

      return {

        ...pattern,

        domainRank:
          index + 1,

        competitiveAdvantage:
          calculateCompetitiveAdvantage(
            pattern,
            ranked
          )

      };

    }
  );

}

/*
==================================================
RANK PATTERNS
==================================================
*/

function rankPatternRecords(
  patterns: PatternIntelligenceRecord[]
): PatternIntelligenceRecord[] {

  return [
    ...patterns
  ].sort(
    (
      a,
      b
    ) => {

      const scoreDifference =
        rankingScore(b) -
        rankingScore(a);

      if (
        scoreDifference !== 0
      ) {

        return scoreDifference;

      }

      /*
      Secondary ordering:

      More successful observations first.
      */

      if (
        b.successes !==
        a.successes
      ) {

        return (
          b.successes -
          a.successes
        );

      }

      /*
      Then newer evidence.
      */

      const aTime =
        Date.parse(
          a.lastSeenAt
        );

      const bTime =
        Date.parse(
          b.lastSeenAt
        );

      return (
        bTime -
        aTime
      );

    }
  );

}

/*
==================================================
PUBLIC API
==================================================
*/

/**
 * Get intelligence for every known pattern
 * belonging to a domain.
 */
export async function getPatternIntelligence(
  domainInput: string
): Promise<PatternIntelligenceResult> {

  const domain =
    normalizeDomain(
      domainInput
    );

  if (!domain) {

    return {

      domain: "",

      patterns: [],

      bestPattern: null,

      hasReliablePattern: false,

      generatedAt:
        new Date().toISOString()

    };

  }

  const historyRows =
    await queryPatternsForDomain(
      domain
    );

  if (
    historyRows.length === 0
  ) {

    return {

      domain,

      patterns: [],

      bestPattern: null,

      hasReliablePattern: false,

      generatedAt:
        new Date().toISOString()

    };

  }

  const observationMap =
    await loadObservationAggregates(
      domain
    );

  const records =
    historyRows.map(
      (
        history
      ) => {

        const observation =
          observationMap.get(
            normalizePattern(
              history.pattern
            )
          );

        return buildIntelligenceRecord(
          history,
          observation
        );

      }
    );

 const rankedPatterns =
    rankPatternRecords(
      records
    );

const patterns =
    assignPatternRankingMetadata(
      rankedPatterns
    );

  const bestPattern =
    patterns.find(
      (
        pattern
      ) =>
        pattern.recommendation ===
          "PREFER" ||
        pattern.recommendation ===
          "ALLOW"
    ) ?? null;

  const hasReliablePattern =
    patterns.some(
      (
        pattern
      ) =>
        pattern.classification ===
          "HIGH_CONFIDENCE" ||
        pattern.classification ===
          "MEDIUM_CONFIDENCE"
    );

  return {

    domain,

    patterns,

    bestPattern,

    hasReliablePattern,

    generatedAt:
      new Date().toISOString()

  };

}

/**
 * Rank known patterns for a domain.
 *
 * This is intentionally an alias around
 * getPatternIntelligence() so callers have
 * a semantic API when they only care about
 * ranking.
 */
export async function calculatePatternIntelligence(
  domain: string
): Promise<PatternIntelligenceRecord[]> {

  const result =
    await getPatternIntelligence(
      domain
    );

  return result.patterns;

}

/**
 * Get the highest-ranked usable pattern
 * for a domain.
 */
export async function getBestPattern(
  domain: string
): Promise<PatternIntelligenceRecord | null> {

  const result =
    await getPatternIntelligence(
      domain
    );

  return result.bestPattern;

}

/**
 * Get intelligence for one specific pattern.
 */
export async function getPatternPatternIntelligence(
  domainInput: string,
  patternInput: string
): Promise<PatternIntelligenceRecord | null> {

  const domain =
    normalizeDomain(
      domainInput
    );

  const pattern =
    normalizePattern(
      patternInput
    );

  if (
    !domain ||
    !pattern
  ) {

    return null;

  }

  const history =
    await queryPatternHistory(
      domain,
      pattern
    );

  if (
    !history
  ) {

    return null;

  }

  const observationMap =
    await loadObservationAggregates(
      domain
    );

  const observation =
    observationMap.get(
      pattern
    );

  return buildIntelligenceRecord(
    history,
    observation
  );

}

/*
==================================================
SHUTDOWN
==================================================

This module shares the application's single
database connection (see src/database/database.ts).
Closing it is owned by closeDatabase() there, not
by this module.
==================================================
*/