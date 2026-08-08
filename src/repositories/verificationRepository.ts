import {
  BaseRepository
} from "./baseRepository.js";


/*
==================================================
VERIFICATION REPOSITORY
==================================================

Purpose:

Persistence layer for verification results.

Responsibilities:

- store latest verification state
- retrieve verification results
- update verification state
- query by email/domain

Does NOT:

- calculate confidence
- perform SMTP checks
- make decisions

==================================================
*/


export type VerificationDecision =
  | "VALID"
  | "INVALID"
  | "UNKNOWN"
  | "RETRY"
  | "MANUAL_REVIEW"
  | "SAFE_TO_SEND"
  | "DO_NOT_SEND";


export type VerificationStatus =
  | "VERIFIED"
  | "INVALID"
  | "UNKNOWN"
  | "PENDING"
  | "RETRY"
  | "CATCH_ALL"
  | "TEMPORARY"
  | "NO_MX"
  | "DNS_ERROR"
  | "SMTP_ERROR";


export interface VerificationResultRecord {

  id:string;

  verification_id:string;

  request_id:string|null;

  email:string;

  domain:string;

  pattern:string|null;

  provider:string|null;

  response_code:number|null;

  response_message:string|null;

  smtp_valid:boolean|null;

  mailbox_exists:boolean|null;

  mx_available:boolean|null;

  catch_all:boolean|null;

  retry_required:boolean|null;

  retry_reason:string|null;

  confidence_score:number|null;

  confidence_level:string|null;

  decision:VerificationDecision|null;

  recommendation:string|null;

  verification_status:VerificationStatus|null;

  created_at:string;

  updated_at:string;

}



export interface CreateVerificationResultInput {

  verificationId:string;

  requestId?:string|null;

  email:string;

  domain:string;

  pattern?:string|null;

  provider?:string|null;

  responseCode?:number|null;

  responseMessage?:string|null;

  smtpValid?:boolean|null;

  mailboxExists?:boolean|null;

  mxAvailable?:boolean|null;

  catchAll?:boolean|null;

  retryRequired?:boolean|null;

  retryReason?:string|null;

  confidenceScore?:number|null;

  confidenceLevel?:string|null;

  decision?:VerificationDecision|null;

  recommendation?:string|null;

  verificationStatus?:VerificationStatus|null;

}



export class VerificationRepository
extends BaseRepository {


  /*
  ==================================================
  CREATE / UPSERT
  ==================================================
  */


  async save(
    input:CreateVerificationResultInput
  ):Promise<void> {

    await this.executeRun(
`
INSERT INTO verification_results (

    id,
    verification_id,
    request_id,
    email,
    domain,
    pattern,
    provider,
    response_code,
    response_message,
    smtp_valid,
    mailbox_exists,
    mx_available,
    catch_all,
    retry_required,
    retry_reason,
    confidence_score,
    confidence_level,
    decision,
    recommendation,
    verification_status,
    created_at,
    updated_at

)

VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
    $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
    NOW(), NOW()
)

ON CONFLICT(verification_id)
DO UPDATE SET

    request_id = EXCLUDED.request_id,
    provider = EXCLUDED.provider,
    response_code = EXCLUDED.response_code,
    response_message = EXCLUDED.response_message,
    smtp_valid = EXCLUDED.smtp_valid,
    mailbox_exists = EXCLUDED.mailbox_exists,
    mx_available = EXCLUDED.mx_available,
    catch_all = EXCLUDED.catch_all,
    retry_required = EXCLUDED.retry_required,
    retry_reason = EXCLUDED.retry_reason,
    confidence_score = EXCLUDED.confidence_score,
    confidence_level = EXCLUDED.confidence_level,
    decision = EXCLUDED.decision,
    recommendation = EXCLUDED.recommendation,
    verification_status = EXCLUDED.verification_status,
    updated_at = NOW()

`,
      [
        this.uuid(),
        input.verificationId,
        input.requestId ?? null,
        this.normalizeEmail(input.email),
        this.normalizeDomain(input.domain),
        input.pattern ?? null,
        input.provider ?? null,
        input.responseCode ?? null,
        input.responseMessage ?? null,
        this.sqliteBool(input.smtpValid),
        this.sqliteBool(input.mailboxExists),
        this.sqliteBool(input.mxAvailable),
        this.sqliteBool(input.catchAll),
        this.sqliteBool(input.retryRequired),
        input.retryReason ?? null,
        input.confidenceScore ?? null,
        input.confidenceLevel ?? null,
        input.decision ?? null,
        input.recommendation ?? null,
        input.verificationStatus ?? null,
      ]
    );

  }



  /*
  ==================================================
  FIND BY VERIFICATION ID
  ==================================================
  */


  async findByVerificationId(
    verificationId:string
  ):Promise<VerificationResultRecord|null> {

    const row =
      await this.queryOne<VerificationResultRecord>(
`
SELECT *
FROM verification_results
WHERE verification_id = $1
LIMIT 1
`,
        [verificationId]
      );

    return row
      ? this.normalizeRow(row)
      : null;

  }



  /*
  ==================================================
  FIND LATEST EMAIL RESULT
  ==================================================
  */


  async findLatestByEmail(
    email:string
  ):Promise<VerificationResultRecord|null> {

    const row =
      await this.queryOne<VerificationResultRecord>(
`
SELECT *
FROM verification_results
WHERE email = $1
ORDER BY created_at DESC
LIMIT 1
`,
        [this.normalizeEmail(email)]
      );

    return row
      ? this.normalizeRow(row)
      : null;

  }



  /*
  ==================================================
  FIND DOMAIN RESULTS
  ==================================================
  */


  async findByDomain(
    domain:string
  ):Promise<VerificationResultRecord[]> {

    const rows =
      await this.queryMany<VerificationResultRecord>(
`
SELECT *
FROM verification_results
WHERE domain = $1
ORDER BY created_at DESC
`,
        [this.normalizeDomain(domain)]
      );

    return rows.map(row => this.normalizeRow(row));

  }



  /*
  ==================================================
  NORMALIZE ROW
  ==================================================

  Converts TIMESTAMPTZ columns (returned by pg as
  Date objects) back to ISO strings, matching the
  existing interface contract used throughout the
  rest of the codebase.
  */

  private normalizeRow(
    row:VerificationResultRecord
  ):VerificationResultRecord {

    return {

      ...row,

      created_at:
        this.isoString(row.created_at) ?? row.created_at,

      updated_at:
        this.isoString(row.updated_at) ?? row.updated_at,

    };

  }



  /*
  ==================================================
  EXISTS
  ==================================================
  */


  async existsByVerificationId(
    verificationId:string
  ):Promise<boolean> {

    return this.exists(
`
SELECT 1
FROM verification_results
WHERE verification_id = $1
`,
      [verificationId]
    );

  }



  /*
  ==================================================
  DELETE
  ==================================================
  */


  async deleteByVerificationId(
    verificationId:string
  ):Promise<number> {

    return this.executeDelete(
`
DELETE FROM verification_results
WHERE verification_id = $1
`,
      [verificationId]
    );

  }

}
