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


  private mapHistoryRow(
    row: PatternHistoryRow
  ): PatternHistoryRow {

    return {

      ...row,

      first_seen_at:
        this.isoString(row.first_seen_at) ?? row.first_seen_at,

      last_seen_at:
        this.isoString(row.last_seen_at) ?? row.last_seen_at,

    };

  }


  private mapObservationRow(
    row: PatternObservationRow
  ): PatternObservationRow {

    return {

      ...row,

      observed_at:
        this.isoString(row.observed_at) ?? row.observed_at,

    };

  }


  /*
  -----------------------------------------------
  HISTORY
  -----------------------------------------------
  */


  async find(
    domain: string,
    pattern: string
  ): Promise<PatternHistoryRow | null> {

    const row =
      await this.queryOne<PatternHistoryRow>(
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
        WHERE domain = $1
        AND pattern = $2
      `,
        [domain, pattern]
      );

    return row ? this.mapHistoryRow(row) : null;

  }


  async findByDomain(
    domain: string
  ): Promise<PatternHistoryRow[]> {

    const rows =
      await this.queryMany<PatternHistoryRow>(
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
        WHERE domain = $1
        ORDER BY confidence DESC, attempts DESC
      `,
        [domain]
      );

    return rows.map(row => this.mapHistoryRow(row));

  }


  async findAll(): Promise<PatternHistoryRow[]> {

    const rows =
      await this.queryMany<PatternHistoryRow>(
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

    return rows.map(row => this.mapHistoryRow(row));

  }


  async upsert(
    row: PatternHistoryRow
  ): Promise<void> {

    await this.executeUpdate(
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
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)

        ON CONFLICT(
          domain,
          pattern
        )

        DO UPDATE SET

          attempts =
            EXCLUDED.attempts,

          successes =
            EXCLUDED.successes,

          failures =
            EXCLUDED.failures,

          confidence =
            EXCLUDED.confidence,

          last_seen_at =
            EXCLUDED.last_seen_at
      `,
      [
        row.domain,
        row.pattern,
        row.attempts,
        row.successes,
        row.failures,
        row.confidence,
        row.first_seen_at,
        row.last_seen_at,
      ]
    );

  }


  async delete(
    domain: string,
    pattern: string
  ): Promise<boolean> {

    return this.withTransaction(
      async (tx) => {

        await this.executeDelete(
          `
            DELETE FROM pattern_observations
            WHERE domain = $1
            AND pattern = $2
          `,
          [domain, pattern],
          tx
        );

        const changes =
          await this.executeDelete(
            `
              DELETE FROM pattern_history
              WHERE domain = $1
              AND pattern = $2
            `,
            [domain, pattern],
            tx
          );

        return changes > 0;

      }
    );

  }


  async deleteDomain(
    domain: string
  ): Promise<number> {

    return this.withTransaction(
      async (tx) => {

        await this.executeDelete(
          `
            DELETE FROM pattern_observations
            WHERE domain = $1
          `,
          [domain],
          tx
        );

        return this.executeDelete(
          `
            DELETE FROM pattern_history
            WHERE domain = $1
          `,
          [domain],
          tx
        );

      }
    );

  }


  /*
  -----------------------------------------------
  OBSERVATIONS
  -----------------------------------------------
  */


  async insertObservation(
    observation: PatternObservationInsert
  ): Promise<number> {

    const id =
      await this.executeInsert(
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
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id
      `,
        [
          observation.domain,
          observation.pattern,
          observation.outcome,
          observation.source,
          observation.responseCode,
          observation.verificationId,
          observation.observedAt ?? this.now(),
          observation.confidenceAtObservation ?? 0,
        ]
      );

    return Number(id);

  }


  async findObservations(
    domain: string,
    pattern: string
  ): Promise<PatternObservationRow[]> {

    const rows =
      await this.queryMany<PatternObservationRow>(
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
        WHERE domain = $1
        AND pattern = $2
        ORDER BY observed_at DESC
      `,
        [domain, pattern]
      );

    return rows.map(row => this.mapObservationRow(row));

  }


}
