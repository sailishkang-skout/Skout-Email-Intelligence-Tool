import {
  BaseRepository
} from "./baseRepository.js";


/*
==================================================
PATTERN HISTORY REPOSITORY
==================================================

Database access layer only.

Responsibilities:

- Read pattern history
- Insert/update pattern history
- Insert observations

No business logic.

==================================================
*/


/*
==================================================
TYPES
==================================================
*/

export type PatternOutcome =
  | "SUCCESS"
  | "FAILURE";


export type PatternObservationSource =
  | "SMTP"
  | "MANUAL"
  | "IMPORTED"
  | "OTHER";


export interface PatternHistoryRow {

  domain: string;

  pattern: string;

  attempts: number;

  successes: number;

  failures: number;

  confidence: number;

  first_seen_at: string;

  last_seen_at: string;

}


export interface PatternObservationInsert {

  domain: string;

  pattern: string;

  outcome:
    | "SUCCESS"
    | "FAILURE";

  source:
    | "SMTP"
    | "MANUAL"
    | "IMPORTED"
    | "OTHER";

  responseCode:
    | number
    | null;

  verificationId:
    | string
    | null;


  /*
  Optional because service layer
  generates these values.
  */

  observedAt?: string;

  confidenceAtObservation?: number;

}


export interface PatternObservationRow {

  id: number;

  domain: string;

  pattern: string;

  outcome: PatternOutcome;

  source: PatternObservationSource;

  response_code: number | null;

  verification_id: string | null;

  observed_at: string;

  confidence_at_observation: number;

}


/*
==================================================
REPOSITORY
==================================================
*/

export class PatternHistoryRepository extends BaseRepository {


  /*
  -----------------------------------------------
  HISTORY
  -----------------------------------------------
  */


  find(
    domain: string,
    pattern: string
  ): PatternHistoryRow | null {

    return this.queryOne<PatternHistoryRow>(
      `
        SELECT
          domain,
          pattern,
          attempts,
          successes,
          failures,
          confidence,
          first_seen_at,
          last_seen_at
        FROM pattern_history
        WHERE domain = ?
        AND pattern = ?
      `,
      domain,
      pattern
    );

  }


  findByDomain(
    domain: string
  ): PatternHistoryRow[] {

    return this.queryMany<PatternHistoryRow>(
      `
        SELECT
          domain,
          pattern,
          attempts,
          successes,
          failures,
          confidence,
          first_seen_at,
          last_seen_at
        FROM pattern_history
        WHERE domain = ?
        ORDER BY confidence DESC, attempts DESC
      `,
      domain
    );

  }


  findAll(): PatternHistoryRow[] {

    return this.queryMany<PatternHistoryRow>(
      `
        SELECT
          domain,
          pattern,
          attempts,
          successes,
          failures,
          confidence,
          first_seen_at,
          last_seen_at
        FROM pattern_history
        ORDER BY domain ASC, confidence DESC
      `
    );

  }


  upsert(
    row: PatternHistoryRow
  ): void {

    this.executeUpdate(
      `
        INSERT INTO pattern_history (
          domain,
          pattern,
          attempts,
          successes,
          failures,
          confidence,
          first_seen_at,
          last_seen_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)

        ON CONFLICT(
          domain,
          pattern
        )

        DO UPDATE SET

          attempts =
            excluded.attempts,

          successes =
            excluded.successes,

          failures =
            excluded.failures,

          confidence =
            excluded.confidence,

          last_seen_at =
            excluded.last_seen_at
      `,
      row.domain,
      row.pattern,
      row.attempts,
      row.successes,
      row.failures,
      row.confidence,
      row.first_seen_at,
      row.last_seen_at
    );

  }


  delete(
    domain: string,
    pattern: string
  ): boolean {

    return this.transaction(
      () => {

        this.executeDelete(
          `
            DELETE FROM pattern_observations
            WHERE domain = ?
            AND pattern = ?
          `,
          domain,
          pattern
        );

        const changes =
          this.executeDelete(
            `
              DELETE FROM pattern_history
              WHERE domain = ?
              AND pattern = ?
            `,
            domain,
            pattern
          );

        return changes > 0;

      }
    );

  }


  deleteDomain(
    domain: string
  ): number {

    return this.transaction(
      () => {

        this.executeDelete(
          `
            DELETE FROM pattern_observations
            WHERE domain = ?
          `,
          domain
        );

        return this.executeDelete(
          `
            DELETE FROM pattern_history
            WHERE domain = ?
          `,
          domain
        );

      }
    );

  }


  /*
  -----------------------------------------------
  OBSERVATIONS
  -----------------------------------------------
  */


  insertObservation(
    observation: PatternObservationInsert
  ): number {

    return this.executeInsert(
      `
        INSERT INTO pattern_observations (
          domain,
          pattern,
          outcome,
          source,
          response_code,
          verification_id,
          observed_at,
          confidence_at_observation
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      observation.domain,
      observation.pattern,
      observation.outcome,
      observation.source,
      observation.responseCode,
      observation.verificationId,
      observation.observedAt ?? this.now(),
      observation.confidenceAtObservation ?? 0
    );

  }


  findObservations(
    domain: string,
    pattern: string
  ): PatternObservationRow[] {

    return this.queryMany<PatternObservationRow>(
      `
        SELECT
          id,
          domain,
          pattern,
          outcome,
          source,
          response_code,
          verification_id,
          observed_at,
          confidence_at_observation
        FROM pattern_observations
        WHERE domain = ?
        AND pattern = ?
        ORDER BY observed_at DESC
      `,
      domain,
      pattern
    );

  }


}
