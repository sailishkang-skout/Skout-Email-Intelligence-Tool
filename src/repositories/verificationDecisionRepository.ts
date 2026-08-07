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



export function createVerificationDecision(
    input: VerificationDecisionInput
): VerificationDecisionRecord {


    const id =
        randomUUID();


    const createdAt =
        new Date().toISOString();

console.log(
  "[DECISION LEDGER] inserting",
  {
    verificationId: input.verificationId,
    email: input.email,
    decision: input.decision,
    status: input.verificationStatus
  }
);

    db.prepare(
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
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?
        )
        `
    )
    .run(
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
    createdAt
);

console.log(
  "[DECISION LEDGER] inserted",
  id
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