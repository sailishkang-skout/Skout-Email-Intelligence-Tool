/*
==================================================
PATTERN STATISTICS ENGINE
==================================================

Enterprise Statistical Engine

Purpose

Transforms historical verification data into
statistically meaningful confidence signals.

This service is PURE.

It does NOT

- access SQLite
- modify history
- modify observations
- perform SMTP
- perform MX
- rank candidates

It ONLY performs mathematical calculations.

Used by

- Pattern Intelligence
- Confidence Engine
- Candidate Ranking
- Future ML Engine

==================================================
*/

export type PatternTrend =
  | "TRENDING_UP"
  | "TRENDING_DOWN"
  | "STABLE"
  | "VOLATILE";

export type PatternRiskLevel =
  | "VERY_LOW"
  | "LOW"
  | "MEDIUM"
  | "HIGH"
  | "CRITICAL";

export interface PatternStatisticsInput {

  attempts: number;

  successes: number;

  failures: number;

  historicalConfidence: number;

  lastSeenAt: string;

}

export interface BayesianResult {

  confidence: number;

  adjustedSuccessRate: number;

}

export interface WilsonResult {

  score: number;

  lowerBound: number;

}

export interface ReliabilityResult {

  score: number;

  bayesianConfidence: number;

  wilsonScore: number;

  sampleStrength: number;

  recencyScore: number;

  stabilityScore: number;

  trend: PatternTrend;

  riskLevel: PatternRiskLevel;

}

/*
==================================================
CONFIGURATION
==================================================
*/

/*
Bayesian Prior

Assume every brand-new pattern starts as if it
already had:

2 successes
2 failures

This prevents a single SMTP success from
immediately becoming "100% confidence".
*/

const PRIOR_SUCCESSES = 2;

const PRIOR_FAILURES = 2;

/*
Wilson Confidence

95%

z = 1.96
*/

const Z = 1.96;

/*
Maximum useful sample.

Additional observations still matter,
but the statistical contribution saturates.
*/

const MAX_SAMPLE_SIZE = 20;

/*
Recency

Half-life

180 days
*/

const RECENCY_HALF_LIFE_DAYS = 180;

/*
==================================================
UTILITIES
==================================================
*/

function clamp(
  value: number,
  min = 0,
  max = 100
): number {

  return Math.max(
    min,
    Math.min(
      max,
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
    ) / multiplier
  );

}

/*
==================================================
SAMPLE STRENGTH
==================================================
*/

export function calculateSampleStrength(
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

  return round(

    clamp(

      Math.sqrt(
        normalized
      ) * 100,

      0,

      100

    )

  );

}

/*
==================================================
RECENCY SCORE
==================================================
*/

export function calculateRecencyScore(
  lastSeenAt: string
): number {

  const timestamp =
    Date.parse(
      lastSeenAt
    );

  if (
    Number.isNaN(
      timestamp
    )
  ) {

    return 0;

  }

  const ageDays =

    Math.max(
      0,
      Date.now() - timestamp
    )

    /

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

  return round(

    clamp(

      decay * 100,

      0,

      100

    )

  );

}

/*
==================================================
BAYESIAN CONFIDENCE
==================================================

Formula

(successes + prior)

------------------------

(attempts + priors)

Produces a much more realistic confidence
than raw success rate.

==================================================
*/

export function calculateBayesianConfidence(

  successes: number,

  failures: number

): BayesianResult {

  const adjustedSuccesses =

    successes +

    PRIOR_SUCCESSES;

  const adjustedFailures =

    failures +

    PRIOR_FAILURES;

  const adjustedAttempts =

    adjustedSuccesses +

    adjustedFailures;

  const adjustedRate =

    adjustedAttempts === 0

      ? 0

      : adjustedSuccesses /

        adjustedAttempts;

  return {

    confidence:

      round(

        adjustedRate *

        100

      ),

    adjustedSuccessRate:

      round(

        adjustedRate

      )

  };

}

/*
==================================================
WILSON SCORE
==================================================

Enterprise lower-confidence estimate.

Protects against tiny sample sizes.

Example

1 success

↓

NOT 100%

Instead roughly

20–30%

depending on confidence interval.

==================================================
*/

export function calculateWilsonScore(

  successes: number,

  failures: number

): WilsonResult {

  const n =

    successes +

    failures;

  if (

    n <= 0

  ) {

    return {

      score: 0,

      lowerBound: 0

    };

  }

  const p =

    successes / n;

  const z2 =

    Z * Z;

  const denominator =

    1 +

    z2 / n;

  const centre =

    p +

    z2 /

    (2 * n);

  const margin =

    Z *

    Math.sqrt(

      (

        p *

        (1 - p)

        +

        z2 /

        (4 * n)

      )

      / n

    );

  const lowerBound =

    (

      centre -

      margin

    )

    /

    denominator;

  return {

    score:

      round(

        clamp(

          lowerBound *

          100,

          0,

          100

        )

      ),

    lowerBound:

      round(

        lowerBound

      )

  };

}
/*
==================================================
PATTERN STABILITY
==================================================

Measures how trustworthy a pattern is based on:

- success rate
- sample size
- historical failures

Output

0–100

Higher is better.

==================================================
*/

export function calculatePatternStability(

  attempts: number,

  successes: number,

  failures: number

): number {

  if (
    attempts <= 0
  ) {

    return 0;

  }

  const successRate =
    successes / attempts;

  /*
  Large datasets become naturally
  more stable.
  */

  const sampleWeight =
    Math.min(
      1,
      attempts / 10
    );

  /*
  Failure penalty.

  Patterns with repeated failures
  become increasingly unstable.
  */

  const failurePenalty =
    Math.min(
      0.50,
      failures * 0.05
    );

  const stability =

    successRate *

    sampleWeight *

    (1 - failurePenalty);

  return round(

    clamp(

      stability * 100,

      0,

      100

    )

  );

}

/*
==================================================
PATTERN TREND
==================================================

Trend is intentionally conservative.

Future versions can compare rolling windows
of observations.

Current implementation:

Very strong pattern
    TRENDING_UP

Weak pattern
    TRENDING_DOWN

Very inconsistent
    VOLATILE

Everything else
    STABLE

==================================================
*/

export function calculateTrend(

  attempts: number,

  successRate: number,

  stabilityScore: number

): PatternTrend {

  if (
    attempts < 3
  ) {

    return "STABLE";

  }

  if (

    stabilityScore >= 90 &&

    successRate >= 0.95

  ) {

    return "TRENDING_UP";

  }

  if (

    stabilityScore < 40 &&

    successRate < 0.60

  ) {

    return "TRENDING_DOWN";

  }

  if (

    stabilityScore < 60 &&

    attempts >= 5

  ) {

    return "VOLATILE";

  }

  return "STABLE";

}

/*
==================================================
PATTERN RISK
==================================================

Risk is the inverse of reliability.

LOW risk

means

high confidence.

==================================================
*/

export function calculateRiskLevel(

  reliabilityScore: number,

  attempts: number,

  successRate: number

): PatternRiskLevel {

  if (
    attempts === 0
  ) {

    return "CRITICAL";

  }

  if (

    reliabilityScore >= 90 &&

    successRate >= 0.95 &&

    attempts >= 10

  ) {

    return "VERY_LOW";

  }

  if (

    reliabilityScore >= 80 &&

    successRate >= 0.90 &&

    attempts >= 5

  ) {

    return "LOW";

  }

  if (

    reliabilityScore >= 60

  ) {

    return "MEDIUM";

  }

  if (

    reliabilityScore >= 40

  ) {

    return "HIGH";

  }

  return "CRITICAL";

}

/*
==================================================
RELIABILITY V2
==================================================

Enterprise composite score.

Weights

Wilson
30%

Bayesian
25%

Historical
20%

Sample
10%

Recency
10%

Stability
5%

==================================================
*/

export function calculateReliabilityScoreV2(

  input: PatternStatisticsInput

): ReliabilityResult {

  const bayesian =

    calculateBayesianConfidence(

      input.successes,

      input.failures

    );

  const wilson =

    calculateWilsonScore(

      input.successes,

      input.failures

    );

  const sampleStrength =

    calculateSampleStrength(

      input.attempts

    );

  const recencyScore =

    calculateRecencyScore(

      input.lastSeenAt

    );

  const stabilityScore =

    calculatePatternStability(

      input.attempts,

      input.successes,

      input.failures

    );

  const reliability =

      wilson.score * 0.30

    + bayesian.confidence * 0.25

    + input.historicalConfidence * 0.20

    + sampleStrength * 0.10

    + recencyScore * 0.10

    + stabilityScore * 0.05;

  const finalScore =

    round(

      clamp(

        reliability,

        0,

        100

      )

    );

  const successRate =

    input.attempts > 0

      ? input.successes /

        input.attempts

      : 0;

  const trend =

    calculateTrend(

      input.attempts,

      successRate,

      stabilityScore

    );

  const riskLevel =

    calculateRiskLevel(

      finalScore,

      input.attempts,

      successRate

    );

  return {

    score:

      finalScore,

    bayesianConfidence:

      bayesian.confidence,

    wilsonScore:

      wilson.score,

    sampleStrength,

    recencyScore,

    stabilityScore,

    trend,

    riskLevel

  };



}
