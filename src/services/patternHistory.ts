import {
  PatternHistoryRepository,
  type PatternHistoryRow,
  type PatternObservationInsert
} from "../repositories/patternHistoryRepository.js";


export type PatternOutcome =
  | "SUCCESS"
  | "FAILURE";


export type PatternObservationSource =
  | "SMTP"
  | "MANUAL"
  | "IMPORTED"
  | "OTHER";


export interface PatternObservationInput {

  domain: string;

  pattern: string;

  outcome: PatternOutcome;

  source: PatternObservationSource;

  responseCode?: number | null;

  verificationId?: string | null;

}


export interface PatternHistoryRecord {

  domain: string;

  pattern: string;

  attempts: number;

  successes: number;

  failures: number;

  confidence: number;

  firstSeenAt: string;

  lastSeenAt: string;

}


export interface RecordPatternObservationResult {

  history: PatternHistoryRecord;

  observationId: number;

}


const repository =
  new PatternHistoryRepository();



function normalizeDomain(
  domain: string
): string {

  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
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



function validate(
  domain: string,
  pattern: string
) {

  const normalizedDomain =
    normalizeDomain(domain);


  const normalizedPattern =
    normalizePattern(pattern);


  if (!normalizedDomain) {

    throw new Error(
      "Invalid domain"
    );

  }


  if (!normalizedPattern) {

    throw new Error(
      "Invalid pattern"
    );

  }


  return {

    domain: normalizedDomain,

    pattern: normalizedPattern

  };

}



function calculateConfidence(
  attempts: number,
  successes: number
): number {

  if (attempts <= 0) {

    return 0;

  }


  const successRate =
    successes / attempts;


  const multiplier =
    Math.min(
      1,
      Math.log10(
        attempts + 1
      )
    );


  return Math.max(
    0,
    Math.min(
      100,
      successRate * 100 * multiplier
    )
  );

}



function mapHistory(
  row: PatternHistoryRow
): PatternHistoryRecord {

  return {

    domain: row.domain,

    pattern: row.pattern,

    attempts: row.attempts,

    successes: row.successes,

    failures: row.failures,

    confidence: row.confidence,

    firstSeenAt: row.first_seen_at,

    lastSeenAt: row.last_seen_at

  };

}



/*
==================================================
READ
==================================================
*/


export async function getPatternHistory(
  domain: string,
  pattern: string
): Promise<PatternHistoryRecord | null> {


  const normalized =
    validate(
      domain,
      pattern
    );


  const row =
    await repository.find(
      normalized.domain,
      normalized.pattern
    );


  return row
    ? mapHistory(row)
    : null;

}



export async function getPatternHistoriesForDomain(
  domain: string
): Promise<PatternHistoryRecord[]> {


  const normalized =
    normalizeDomain(domain);


  if (!normalized) {

    return [];

  }


  const rows =
    await repository.findByDomain(normalized);

  return rows.map(mapHistory);

}



export async function getAllPatternHistory()
: Promise<PatternHistoryRecord[]> {

  const rows =
    await repository.findAll();

  return rows.map(mapHistory);

}



/*
==================================================
CREATE OBSERVATION
==================================================
*/


export async function recordPatternObservation(
  input: PatternObservationInput
): Promise<RecordPatternObservationResult> {


  const normalized =
    validate(
      input.domain,
      input.pattern
    );


  const existing =
    await repository.find(
      normalized.domain,
      normalized.pattern
    );


  const attempts =
    (existing?.attempts ?? 0) + 1;


  const successes =
    (existing?.successes ?? 0)
    +
    (
      input.outcome === "SUCCESS"
        ? 1
        : 0
    );


  const failures =
    (existing?.failures ?? 0)
    +
    (
      input.outcome === "FAILURE"
        ? 1
        : 0
    );


  const confidence =
    calculateConfidence(
      attempts,
      successes
    );


  const now =
    new Date()
      .toISOString();



  await repository.upsert({

    domain: normalized.domain,

    pattern: normalized.pattern,

    attempts,

    successes,

    failures,

    confidence,

    first_seen_at:
      existing?.first_seen_at ?? now,

    last_seen_at:
      now

  });



  const observation: PatternObservationInsert = {

    domain: normalized.domain,

    pattern: normalized.pattern,

    outcome: input.outcome,

    source: input.source,

    responseCode:
      input.responseCode ?? null,

    verificationId:
      input.verificationId ?? null,

    observedAt: now,

    confidenceAtObservation:
      confidence

  };



  const observationId =
    await repository.insertObservation(
      observation
    );



  const updated =
    await repository.find(
      normalized.domain,
      normalized.pattern
    );


  if (!updated) {

    throw new Error(
      "Pattern history missing after update"
    );

  }


  return {

    history:
      mapHistory(updated),

    observationId

  };

}



/*
==================================================
HELPERS
==================================================
*/


export async function recordPatternResult(
  domain: string,
  pattern: string,
  outcome: PatternOutcome,
  source: PatternObservationSource = "OTHER",
  responseCode: number | null = null,
  verificationId: string | null = null
): Promise<PatternHistoryRecord> {


  const result =
    await recordPatternObservation({

      domain,

      pattern,

      outcome,

      source,

      responseCode,

      verificationId

    });

  return result.history;

}



export async function recordPatternSuccess(
  domain: string,
  pattern: string,
  source: PatternObservationSource = "OTHER",
  responseCode: number | null = null,
  verificationId: string | null = null
) {

  return recordPatternResult(
    domain,
    pattern,
    "SUCCESS",
    source,
    responseCode,
    verificationId
  );

}



export async function recordPatternFailure(
  domain: string,
  pattern: string,
  source: PatternObservationSource = "OTHER",
  responseCode: number | null = null,
  verificationId: string | null = null
) {

  return recordPatternResult(
    domain,
    pattern,
    "FAILURE",
    source,
    responseCode,
    verificationId
  );

}



/*
==================================================
RESET
==================================================
*/


export async function resetPatternHistory(
  domain: string,
  pattern: string
): Promise<boolean> {

  const normalized =
    validate(
      domain,
      pattern
    );


  return repository.delete(
    normalized.domain,
    normalized.pattern
  );

}



export async function resetDomainPatternHistory(
  domain: string
): Promise<number> {

  return repository.deleteDomain(
    normalizeDomain(domain)
  );

}



/*
==================================================
OBSERVATIONS
==================================================
*/


export async function getPatternObservations(
  domain: string,
  pattern: string
) {

  const normalized =
    validate(
      domain,
      pattern
    );


  return repository.findObservations(
    normalized.domain,
    normalized.pattern
  );

}



export default {

  getPatternHistory,

  getPatternHistoriesForDomain,

  getAllPatternHistory,

  recordPatternObservation,

  recordPatternResult,

  recordPatternSuccess,

  recordPatternFailure,

  resetPatternHistory,

  resetDomainPatternHistory,

  getPatternObservations

};
