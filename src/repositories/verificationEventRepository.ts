import { randomUUID } from "node:crypto";

import { BaseRepository } from "./baseRepository.js";


export type VerificationStage =
  | "VERIFICATION"
  | "MX"
  | "SMTP"
  | "CATCH_ALL"
  | "EVIDENCE"
  | "DECISION"
  | "PATTERN";


export type VerificationEventStatus =
  | "STARTED"
  | "COMPLETED"
  | "FAILED";


export interface VerificationEventRecord {

  id: string;

  verificationId: string;

  stage: VerificationStage;

  status: VerificationEventStatus;

  metadata: Record<string, unknown> | null;

  createdAt: string;

}


interface VerificationEventRow {

  id: string;

  verification_id: string;

  stage: VerificationStage;

  status: VerificationEventStatus;

  metadata: unknown;

  created_at: string | Date;

}


export class VerificationEventRepository
  extends BaseRepository {


  async createEvent(input: {

    verificationId: string;

    stage: VerificationStage;

    status: VerificationEventStatus;

    metadata?: Record<string, unknown>;

  }): Promise<VerificationEventRecord> {

    const id =
      randomUUID();

    const createdAt =
      new Date().toISOString();

    await this.executeRun(
      `
      INSERT INTO verification_events
      (
        id,
        verification_id,
        stage,
        status,
        metadata,
        created_at
      )
      VALUES
      (
        $1, $2, $3, $4, $5, $6
      )
      `,
      [
        id,
        input.verificationId,
        input.stage,
        input.status,
        input.metadata
          ? JSON.stringify(input.metadata)
          : null,
        createdAt,
      ]
    );

    return {

      id,

      verificationId:
        input.verificationId,

      stage:
        input.stage,

      status:
        input.status,

      metadata:
        input.metadata ?? null,

      createdAt

    };

  }


  private mapRow(
    row: VerificationEventRow
  ): VerificationEventRecord {

    return {

      id:
        row.id,

      verificationId:
        row.verification_id,

      stage:
        row.stage,

      status:
        row.status,

      metadata:
        // JSONB columns are already parsed by pg.
        (row.metadata as Record<string, unknown> | null) ?? null,

      createdAt:
        this.isoString(row.created_at) ?? String(row.created_at)

    };

  }


  async getByVerificationId(
    verificationId: string
  ): Promise<VerificationEventRecord[]> {

    const rows =
      await this.queryMany<VerificationEventRow>(
        `
        SELECT
          id,
          verification_id,
          stage,
          status,
          metadata,
          created_at
        FROM verification_events
        WHERE verification_id = $1
        ORDER BY created_at ASC
        `,
        [verificationId]
      );

    return rows.map(row => this.mapRow(row));

  }


  async getLatestEvent(
    verificationId: string
  ): Promise<VerificationEventRecord | null> {

    const row =
      await this.queryOne<VerificationEventRow>(
        `
        SELECT
          id,
          verification_id,
          stage,
          status,
          metadata,
          created_at
        FROM verification_events
        WHERE verification_id = $1
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [verificationId]
      );

    return row ? this.mapRow(row) : null;

  }


  async getEventsByStage(
    verificationId: string,
    stage: VerificationStage
  ): Promise<VerificationEventRecord[]> {

    const rows =
      await this.queryMany<VerificationEventRow>(
        `
        SELECT
          id,
          verification_id,
          stage,
          status,
          metadata,
          created_at
        FROM verification_events
        WHERE verification_id = $1
        AND stage = $2
        ORDER BY created_at ASC
        `,
        [verificationId, stage]
      );

    return rows.map(row => this.mapRow(row));

  }


  async countEvents(
    verificationId: string
  ): Promise<number> {

    return this.count(
      `
      SELECT
        COUNT(*) AS total
      FROM verification_events
      WHERE verification_id = $1
      `,
      [verificationId]
    );

  }


  async deleteByVerificationId(
    verificationId: string
  ): Promise<void> {

    await this.executeRun(
      `
      DELETE
      FROM verification_events
      WHERE verification_id = $1
      `,
      [verificationId]
    );

  }

}
