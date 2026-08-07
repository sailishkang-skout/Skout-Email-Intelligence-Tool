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

  metadata: string | null;

  created_at: string;

}


export class VerificationEventRepository
  extends BaseRepository {


  createEvent(input: {

    verificationId: string;

    stage: VerificationStage;

    status: VerificationEventStatus;

    metadata?: Record<string, unknown>;

  }): VerificationEventRecord {

    const id =
      randomUUID();

    const createdAt =
      new Date().toISOString();

    this.executeRun(
      `
      INSERT INTO verification_events
      (
        id,
        verification_id,
        stage,
        status,
        metadata
      )
      VALUES
      (
        ?,
        ?,
        ?,
        ?,
        ?
      )
      `,
      id,
      input.verificationId,
      input.stage,
      input.status,
      input.metadata
        ? JSON.stringify(input.metadata)
        : null
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


  getByVerificationId(
    verificationId: string
  ): VerificationEventRecord[] {

    const rows =
      this.queryMany<VerificationEventRow>(
        `
        SELECT
          id,
          verification_id,
          stage,
          status,
          metadata,
          created_at
        FROM verification_events
        WHERE verification_id = ?
        ORDER BY created_at ASC
        `,
        verificationId
      );

    return rows.map(row => ({

      id:
        row.id,

      verificationId:
        row.verification_id,

      stage:
        row.stage,

      status:
        row.status,

      metadata:
        row.metadata
          ? JSON.parse(row.metadata) as Record<string, unknown>
          : null,

      createdAt:
        row.created_at

    }));

  }


  getLatestEvent(
    verificationId: string
  ): VerificationEventRecord | null {

    const row =
      this.queryOne<VerificationEventRow>(
        `
        SELECT
          id,
          verification_id,
          stage,
          status,
          metadata,
          created_at
        FROM verification_events
        WHERE verification_id = ?
        ORDER BY created_at DESC
        LIMIT 1
        `,
        verificationId
      );

    if (!row) {
      return null;
    }

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
        row.metadata
          ? JSON.parse(row.metadata) as Record<string, unknown>
          : null,

      createdAt:
        row.created_at

    };

  }


  getEventsByStage(
    verificationId: string,
    stage: VerificationStage
  ): VerificationEventRecord[] {

    const rows =
      this.queryMany<VerificationEventRow>(
        `
        SELECT
          id,
          verification_id,
          stage,
          status,
          metadata,
          created_at
        FROM verification_events
        WHERE verification_id = ?
        AND stage = ?
        ORDER BY created_at ASC
        `,
        verificationId,
        stage
      );

    return rows.map(row => ({

      id:
        row.id,

      verificationId:
        row.verification_id,

      stage:
        row.stage,

      status:
        row.status,

      metadata:
        row.metadata
          ? JSON.parse(row.metadata) as Record<string, unknown>
          : null,

      createdAt:
        row.created_at

    }));

  }


  countEvents(
    verificationId: string
  ): number {

    const row =
      this.queryOne<{
        total: number;
      }>(
        `
        SELECT
          COUNT(*) AS total
        FROM verification_events
        WHERE verification_id = ?
        `,
        verificationId
      );

    return row?.total ?? 0;

  }


  deleteByVerificationId(
    verificationId: string
  ): void {

    this.executeRun(
      `
      DELETE
      FROM verification_events
      WHERE verification_id = ?
      `,
      verificationId
    );

  }

}