import { randomUUID } from "node:crypto";

import db from "../database/database.js";


export interface VerificationDecisionInput {

    verificationId: string;

    email: string;

    decision: string;

    verificationStatus: string;

    confidenceScore: number;

    confidenceLevel: string;

    reasonCodes: string[];

    evidenceSnapshot: Record<string, unknown>;

    engineVersion: string;
}



export interface VerificationDecisionRecord {

    id: string;

    verificationId: string;

    email: string;

    decision: string;

    verificationStatus: string;

    confidenceScore: number;

    confidenceLevel: string;

    reasonCodes: string[];

    evidenceSnapshot: Record<string, unknown>;

    engineVersion: string;

    createdAt: string;
}



export async function createVerificationDecision(
    input: VerificationDecisionInput
): Promise<VerificationDecisionRecord> {


    const id =
        randomUUID();

    const createdAt =
        new Date().toISOString();

    await db.query(
        `
        INSERT INTO verification_decisions
        (
            id,
            verification_id,
            email,
            decision,
            verification_status,
            confidence_score,
            confidence_level,
            reason_codes,
            evidence_snapshot,
            engine_version,
            created_at
        )
        VALUES
        (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
        )
        `,
        [
            id,
            input.verificationId,
            input.email,
            input.decision,
            input.verificationStatus,
            input.confidenceScore,
            input.confidenceLevel,
            JSON.stringify(input.reasonCodes),
            JSON.stringify(input.evidenceSnapshot),
            input.engineVersion,
            createdAt,
        ]
    );

    return {

        id,

        verificationId:
            input.verificationId,

        email:
            input.email,

        decision:
            input.decision,

        verificationStatus:
            input.verificationStatus,

        confidenceScore:
            input.confidenceScore,

        confidenceLevel:
            input.confidenceLevel,

        reasonCodes:
            input.reasonCodes,

        evidenceSnapshot:
            input.evidenceSnapshot,

        engineVersion:
            input.engineVersion,

        createdAt
    };

}


interface VerificationDecisionRow {

    id: string;

    verification_id: string;

    email: string;

    decision: string;

    verification_status: string;

    confidence_score: number;

    confidence_level: string;

    reason_codes: unknown;

    evidence_snapshot: unknown;

    engine_version: string;

    created_at: string | Date;

}


function mapRow(
    row: VerificationDecisionRow
): VerificationDecisionRecord {

    return {

        id: row.id,

        verificationId: row.verification_id,

        email: row.email,

        decision: row.decision,

        verificationStatus: row.verification_status,

        confidenceScore: row.confidence_score,

        confidenceLevel: row.confidence_level,

        // JSONB columns are already parsed by pg.
        reasonCodes: row.reason_codes as string[],

        evidenceSnapshot: row.evidence_snapshot as Record<string, unknown>,

        engineVersion: row.engine_version,

        createdAt:
            row.created_at instanceof Date
                ? row.created_at.toISOString()
                : String(row.created_at),

    };

}


export async function findVerificationDecisionByVerificationId(
    verificationId: string
): Promise<VerificationDecisionRecord | null> {

    const result =
        await db.query<VerificationDecisionRow>(
            `
            SELECT *
            FROM verification_decisions
            WHERE verification_id = $1
            LIMIT 1
            `,
            [verificationId]
        );

    const row = result.rows[0];

    return row ? mapRow(row) : null;

}
