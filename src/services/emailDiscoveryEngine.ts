import {
  generateEmailPermutations
} from "./emailPermutationEngine.js";

import {
  rankEmailCandidates,
  type RankedEmailCandidate
} from "./patternRanker.js";

import {
  verifyEmail
} from "./emailVerificationOrchestrator.js";

/*
==================================================
EMAIL DISCOVERY ENGINE
==================================================

Flow:

PERSON
  ↓
PERMUTATION ENGINE
  ↓
PATTERN RANKER
  ↓
SMTP VERIFICATION
  ↓
PATTERN HISTORY UPDATE
  ↓
PATTERN INTELLIGENCE REFRESH
  ↓
RE-RANK
  ↓
RECOMMENDED EMAIL

Important:

generateEmailPermutations() returns:

{
  candidates: EmailPermutationCandidate[],
  ...
}

The discovery engine normalizes that result into
the candidate array immediately so all downstream
ranking logic works with the expected array type.
==================================================
*/

/*
==================================================
INPUT
==================================================
*/

export interface EmailDiscoveryInput {
  firstName: string;
  lastName?: string | null;
  domain: string;

  /**
   * Maximum number of candidates to verify.
   *
   * Default: 3
   * Maximum: 20
   */
  maxVerifications?: number;

  /**
   * Whether SMTP verification should run.
   *
   * Default: true
   */
  verify?: boolean;
}

/*
==================================================
VERIFICATION RESULT
==================================================
*/

export interface EmailDiscoveryVerification {
  email: string;

  success: boolean;

  responseCode: number | null;

  mailboxExists: boolean;

  smtpValid: boolean;

  catchAll: boolean;

  confidence: number | null;

  status: string | null;

  recommendation: unknown | null;

  error: string | null;
}

/*
==================================================
DISCOVERY CANDIDATE
==================================================
*/

export interface EmailDiscoveryCandidate {
  email: string;

  pattern: string;

  originalRank: number;

  finalScore: number;

  decision: string;

  confidence: number;

  attempts: number;

  successes: number;

  failures: number;

  historicalSuccessRate: number;

  reasons: string[];

  verification:
    | EmailDiscoveryVerification
    | null;
}

/*
==================================================
FINAL RESULT
==================================================
*/

export interface EmailDiscoveryResult {
  success: boolean;

  firstName: string;

  lastName: string | null;

  domain: string;

  generatedCount: number;

  rankedCount: number;

  verifiedCount: number;

  recommendedEmail: string | null;

  recommendedPattern: string | null;

  recommendedConfidence: number | null;

  candidates: EmailDiscoveryCandidate[];
}

/*
==================================================
DEFAULTS
==================================================
*/

const DEFAULT_MAX_VERIFICATIONS = 3;

const MAX_VERIFICATIONS = 20;

/*
==================================================
NORMALIZATION
==================================================
*/

function normalizeText(
  value: string
): string {
  return value
    .trim()
    .toLowerCase();
}

function normalizeOptionalText(
  value?: string | null
): string | null {

  if (
    value === undefined ||
    value === null
  ) {
    return null;
  }

  const normalized =
    value.trim();

  return normalized
    ? normalized.toLowerCase()
    : null;
}

function normalizeDomain(
  value: string
): string {

  return value
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
INPUT VALIDATION
==================================================
*/

function validateInput(
  input: EmailDiscoveryInput
): void {

  if (
    !input ||
    typeof input !== "object"
  ) {
    throw new Error(
      "Email discovery input is required"
    );
  }

  if (
    typeof input.firstName !== "string" ||
    !input.firstName.trim()
  ) {
    throw new Error(
      "firstName is required"
    );
  }

  if (
    typeof input.domain !== "string" ||
    !input.domain.trim()
  ) {
    throw new Error(
      "domain is required"
    );
  }
}

/*
==================================================
MAX VERIFICATIONS
==================================================
*/

function normalizeMaxVerifications(
  value?: number
): number {

  if (
    value === undefined
  ) {
    return DEFAULT_MAX_VERIFICATIONS;
  }

  if (
    !Number.isFinite(value)
  ) {
    return DEFAULT_MAX_VERIFICATIONS;
  }

  return Math.max(
    0,
    Math.min(
      Math.floor(value),
      MAX_VERIFICATIONS
    )
  );
}

/*
==================================================
PERMUTATION RESULT NORMALIZATION
==================================================

CRITICAL FIX.

generateEmailPermutations() returns an object.

Example:

{
  candidates: [...],
  generatedCount: 22
}

The ranking engine expects:

EmailPermutationCandidate[]

Therefore unwrap candidates here.

==================================================
*/

type GeneratedPermutationCandidates =
  ReturnType<
    typeof generateEmailPermutations
  > extends {
    candidates: infer Candidates;
  }
    ? Candidates
    : never;

function extractGeneratedCandidates(
  generatedResult:
    ReturnType<
      typeof generateEmailPermutations
    >
): GeneratedPermutationCandidates {

  if (
    !generatedResult ||
    typeof generatedResult !== "object"
  ) {
    throw new Error(
      "Email permutation engine returned an invalid result"
    );
  }

  if (
    !Array.isArray(
      generatedResult.candidates
    )
  ) {
    throw new Error(
      "Email permutation engine did not return a candidates array"
    );
  }

  return generatedResult.candidates;
}

/*
==================================================
VERIFY ONE CANDIDATE
==================================================
*/

async function verifyCandidate(
  candidate: RankedEmailCandidate
): Promise<EmailDiscoveryVerification> {

  try {

    const result =
      await verifyEmail(
        candidate.email
      );

    const smtp =
      result.smtp;

    const intelligence =
      result.intelligence;

    return {

      email:
        candidate.email,

      success:
        Boolean(
          result.success
        ),

      responseCode:
        typeof smtp?.responseCode === "number"
          ? smtp.responseCode
          : null,

      mailboxExists:
        Boolean(
          smtp?.mailboxExists
        ),

      smtpValid:
        Boolean(
          smtp?.smtpValid
        ),

      catchAll:
        Boolean(
          result.catchAll
        ),

      confidence:
        typeof intelligence?.score === "number"
          ? intelligence.score
          : null,

      status:
        typeof intelligence?.status === "string"
          ? intelligence.status
          : null,

      recommendation:
        intelligence?.recommendation ?? null,

      error:
        null
    };

  } catch (
    error
  ) {

    return {

      email:
        candidate.email,

      success:
        false,

      responseCode:
        null,

      mailboxExists:
        false,

      smtpValid:
        false,

      catchAll:
        false,

      confidence:
        null,

      status:
        null,

      recommendation:
        null,

      error:
        error instanceof Error
          ? error.message
          : String(error)
    };
  }
}

/*
==================================================
MAP UNVERIFIED CANDIDATE
==================================================
*/

function mapUnverifiedCandidate(
  candidate: RankedEmailCandidate
): EmailDiscoveryCandidate {

  return {

    email:
      candidate.email,

    pattern:
      candidate.pattern,

    originalRank:
      candidate.originalRank,

    finalScore:
      candidate.finalScore,

    decision:
      candidate.decision,

    confidence:
      candidate.confidence,

    attempts:
      candidate.attempts,

    successes:
      candidate.successes,

    failures:
      candidate.failures,

    historicalSuccessRate:
      candidate.historicalSuccessRate,

    reasons:
      candidate.reasons,

    verification:
      null
  };
}

/*
==================================================
MAP VERIFIED CANDIDATE
==================================================
*/

function mapVerifiedCandidate(
  candidate: RankedEmailCandidate,
  verification: EmailDiscoveryVerification
): EmailDiscoveryCandidate {

  return {

    email:
      candidate.email,

    pattern:
      candidate.pattern,

    originalRank:
      candidate.originalRank,

    finalScore:
      candidate.finalScore,

    decision:
      candidate.decision,

    confidence:
      candidate.confidence,

    attempts:
      candidate.attempts,

    successes:
      candidate.successes,

    failures:
      candidate.failures,

    historicalSuccessRate:
      candidate.historicalSuccessRate,

    reasons:
      candidate.reasons,

    verification
  };
}

/*
==================================================
REFRESH VERIFIED CANDIDATE
==================================================

After verifyEmail():

5 / 5 / 88
    ↓
6 / 6 / 89

The ranking is therefore recalculated so the
current API response reflects the new observation.

==================================================
*/

async function refreshCandidateAfterVerification(
  domain: string,
  generatedCandidates:
    Parameters<
      typeof rankEmailCandidates
    >[1],
  verifiedEmail: string
): Promise<RankedEmailCandidate | null> {

  const refreshedRanking =
    await rankEmailCandidates(
      domain,
      generatedCandidates
    );

  const refreshedCandidate =
    refreshedRanking.candidates.find(
      (
        candidate
      ) =>
        candidate.email ===
        verifiedEmail
    );

  return (
    refreshedCandidate ??
    null
  );
}

/*
==================================================
SORT CANDIDATES
==================================================
*/

function sortDiscoveryCandidates(
  candidates: EmailDiscoveryCandidate[]
): void {

  candidates.sort(
    (
      a,
      b
    ) => {

      /*
      --------------------------------------------
      CONFIRMED MAILBOX
      --------------------------------------------
      */

      const aMailboxConfirmed =
        Boolean(
          a.verification?.success &&
          a.verification?.mailboxExists &&
          !a.verification?.catchAll
        );

      const bMailboxConfirmed =
        Boolean(
          b.verification?.success &&
          b.verification?.mailboxExists &&
          !b.verification?.catchAll
        );

      if (
        aMailboxConfirmed !==
        bMailboxConfirmed
      ) {

        return aMailboxConfirmed
          ? -1
          : 1;
      }

      /*
      --------------------------------------------
      SMTP VALID
      --------------------------------------------
      */

      const aSMTPValid =
        Boolean(
          a.verification?.smtpValid
        );

      const bSMTPValid =
        Boolean(
          b.verification?.smtpValid
        );

      if (
        aSMTPValid !==
        bSMTPValid
      ) {

        return aSMTPValid
          ? -1
          : 1;
      }

      /*
      --------------------------------------------
      VERIFICATION CONFIDENCE
      --------------------------------------------
      */

      const aVerificationConfidence =
        a.verification?.confidence ??
        -1;

      const bVerificationConfidence =
        b.verification?.confidence ??
        -1;

      if (
        aVerificationConfidence !==
        bVerificationConfidence
      ) {

        return (
          bVerificationConfidence -
          aVerificationConfidence
        );
      }

      /*
      --------------------------------------------
      RANKED SCORE
      --------------------------------------------
      */

      if (
        a.finalScore !==
        b.finalScore
      ) {

        return (
          b.finalScore -
          a.finalScore
        );
      }

      /*
      --------------------------------------------
      ORIGINAL RANK
      --------------------------------------------
      */

      return (
        a.originalRank -
        b.originalRank
      );
    }
  );
}

/*
==================================================
RECOMMENDATION
==================================================
*/

function chooseRecommendedCandidate(
  candidates: EmailDiscoveryCandidate[]
): EmailDiscoveryCandidate | null {

  if (
    candidates.length === 0
  ) {
    return null;
  }

  /*
  --------------------------------------------
  1. VERIFIED NON-CATCH-ALL
  --------------------------------------------
  */

  const verified =
    candidates.find(
      (
        candidate
      ) =>
        candidate.verification?.success === true &&
        candidate.verification?.mailboxExists === true &&
        candidate.verification?.smtpValid === true &&
        candidate.verification?.catchAll === false
    );

  if (
    verified
  ) {
    return verified;
  }

  /*
  --------------------------------------------
  2. STRONGEST SMTP RESULT
  --------------------------------------------
  */

  const smtpValid =
    candidates.find(
      (
        candidate
      ) =>
        candidate.verification?.smtpValid === true &&
        candidate.verification?.catchAll === false
    );

  if (
    smtpValid
  ) {
    return smtpValid;
  }

  /*
  --------------------------------------------
  3. RANKED BEST CANDIDATE
  --------------------------------------------
  */

  return candidates[0] ?? null;
}

/*
==================================================
MAIN DISCOVERY FUNCTION
==================================================
*/

export async function discoverEmail(
  input: EmailDiscoveryInput
): Promise<EmailDiscoveryResult> {

  /*
  ------------------------------------------------
  VALIDATE
  ------------------------------------------------
  */

  validateInput(
    input
  );

  /*
  ------------------------------------------------
  NORMALIZE
  ------------------------------------------------
  */

  const firstName =
    normalizeText(
      input.firstName
    );

  const lastName =
    normalizeOptionalText(
      input.lastName
    );

  const domain =
    normalizeDomain(
      input.domain
    );

  if (
    !domain
  ) {
    throw new Error(
      "Invalid domain"
    );
  }

  /*
  ------------------------------------------------
  OPTIONS
  ------------------------------------------------
  */

  const maxVerifications =
    normalizeMaxVerifications(
      input.maxVerifications
    );

  const shouldVerify =
    input.verify !== false;

  /*
  ------------------------------------------------
  GENERATE PERMUTATIONS
  ------------------------------------------------

  FIX:

  The permutation engine returns an object.

  We extract:

      generatedResult.candidates

  and use ONLY the array from this point onward.
  ------------------------------------------------
  */

  const generatedResult =
    generateEmailPermutations({

      firstName,

      lastName,

      domain
    });

  const generated =
    extractGeneratedCandidates(
      generatedResult
    );

  /*
  ------------------------------------------------
  INITIAL RANKING
  ------------------------------------------------
  */

  let ranking =
    await rankEmailCandidates(
      domain,
      generated
    );

  /*
  ------------------------------------------------
  VERIFY TOP CANDIDATES
  ------------------------------------------------
  */

  const candidateMap =
    new Map<
      string,
      EmailDiscoveryCandidate
    >();

  /*
  Start with all candidates unverified.
  */

  for (
    const candidate of ranking.candidates
  ) {

    candidateMap.set(
      candidate.email,
      mapUnverifiedCandidate(
        candidate
      )
    );
  }

  /*
  ------------------------------------------------
  VERIFICATION LOOP
  ------------------------------------------------
  */

  let verifiedCount = 0;

  if (
    shouldVerify &&
    maxVerifications > 0
  ) {

    const candidatesToVerify =
      ranking.candidates
        .slice(
          0,
          maxVerifications
        );

    for (
      const candidate
      of candidatesToVerify
    ) {

      const verification =
        await verifyCandidate(
          candidate
        );

      verifiedCount += 1;

      /*
      --------------------------------------------
      IMPORTANT
      --------------------------------------------

      The SMTP result may have changed pattern
      history.

      Re-rank immediately after verification.
      --------------------------------------------
      */

      const refreshedCandidate =
        await refreshCandidateAfterVerification(
          domain,
          generated,
          candidate.email
        );

      /*
      If the pattern disappeared from the
      refreshed ranking, retain the old candidate
      metadata but attach the verification result.
      */

      if (
        refreshedCandidate
      ) {

        candidateMap.set(
          candidate.email,
          mapVerifiedCandidate(
            refreshedCandidate,
            verification
          )
        );

      } else {

        candidateMap.set(
          candidate.email,
          mapVerifiedCandidate(
            candidate,
            verification
          )
        );
      }

      /*
      --------------------------------------------
      STOP EARLY ON VERIFIED MAILBOX
      --------------------------------------------
      */

      if (
        verification.success &&
        verification.mailboxExists &&
        verification.smtpValid &&
        !verification.catchAll
      ) {

        break;
      }
    }
  }

  /*
  ------------------------------------------------
  FINAL RANKING
  ------------------------------------------------

  IMPORTANT:

  Re-rank one final time after all verification
  observations have been recorded.

  This guarantees the returned historical
  attempts/successes/confidence are current.
  ------------------------------------------------
  */

  ranking =
    await rankEmailCandidates(
      domain,
      generated
    );

  /*
  ------------------------------------------------
  REBUILD FINAL CANDIDATES
  ------------------------------------------------
  */

  const finalCandidates =
    ranking.candidates.map(
      (
        candidate
      ) => {

        const existing =
          candidateMap.get(
            candidate.email
          );

        if (
          existing
        ) {

          return {

            ...mapVerifiedCandidate(
              candidate,
              existing.verification!
            ),

            verification:
              existing.verification
          };
        }

        return mapUnverifiedCandidate(
          candidate
        );
      }
    );

  /*
  ------------------------------------------------
  SORT
  ------------------------------------------------
  */

  sortDiscoveryCandidates(
    finalCandidates
  );

  /*
  ------------------------------------------------
  RECOMMENDED CANDIDATE
  ------------------------------------------------
  */

  const recommended =
    chooseRecommendedCandidate(
      finalCandidates
    );

  /*
  ------------------------------------------------
  FINAL RESPONSE
  ------------------------------------------------
  */

  return {

    success:
      true,

    firstName,

    lastName,

    domain,

    generatedCount:
      generated.length,

    rankedCount:
      ranking.candidates.length,

    verifiedCount,

    recommendedEmail:
      recommended?.email ??
      null,

    recommendedPattern:
      recommended?.pattern ??
      null,

    recommendedConfidence:
      recommended
        ? (
            recommended.verification?.confidence ??
            recommended.confidence
          )
        : null,

    candidates:
      finalCandidates
  };
}