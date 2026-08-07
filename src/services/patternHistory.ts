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


export function getPatternHistory(
  domain: string,
  pattern: string
): PatternHistoryRecord | null {


  const normalized =
    validate(
      domain,
      pattern
    );


  const row =
    repository.find(
      normalized.domain,
      normalized.pattern
    );


  return row
    ? mapHistory(row)
    : null;

}



export function getPatternHistoriesForDomain(
  domain: string
): PatternHistoryRecord[] {


  const normalized =
    normalizeDomain(domain);


  if (!normalized) {

    return [];

  }


  return repository
    .findByDomain(normalized)
    .map(mapHistory);

}



export function getAllPatternHistory()
: PatternHistoryRecord[] {


  return repository
    .findAll()
    .map(mapHistory);

}



/*
==================================================
CREATE OBSERVATION
==================================================
*/


export function recordPatternObservation(
  input: PatternObservationInput
): RecordPatternObservationResult {


  const normalized =
    validate(
      input.domain,
      input.pattern
    );


  const existing =
    repository.find(
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



  repository.upsert({

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
    repository.insertObservation(
      observation
    );



  const updated =
    repository.find(
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


export function recordPatternResult(
  domain: string,
  pattern: string,
  outcome: PatternOutcome,
  source: PatternObservationSource = "OTHER",
  responseCode: number | null = null,
  verificationId: string | null = null
): PatternHistoryRecord {


  return recordPatternObservation({

    domain,

    pattern,

    outcome,

    source,

    responseCode,

    verificationId

  }).history;

}



export function recordPatternSuccess(
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



export function recordPatternFailure(
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


export function resetPatternHistory(
  domain: string,
  pattern: string
): boolean {

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



export function resetDomainPatternHistory(
  domain: string
): number {

  return repository.deleteDomain(
    normalizeDomain(domain)
  );

}



/*
==================================================
OBSERVATIONS
==================================================
*/


export function getPatternObservations(
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