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


  save(
    input:CreateVerificationResultInput
  ):void {


    const now =
      this.now();


    this.executeRun(
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
    ?,
    ?

)

ON CONFLICT(verification_id)
DO UPDATE SET

    request_id = excluded.request_id,
    provider = excluded.provider,
    response_code = excluded.response_code,
    response_message = excluded.response_message,
    smtp_valid = excluded.smtp_valid,
    mailbox_exists = excluded.mailbox_exists,
    mx_available = excluded.mx_available,
    catch_all = excluded.catch_all,
    retry_required = excluded.retry_required,
    retry_reason = excluded.retry_reason,
    confidence_score = excluded.confidence_score,
    confidence_level = excluded.confidence_level,
    decision = excluded.decision,
    recommendation = excluded.recommendation,
    verification_status = excluded.verification_status,
    updated_at = excluded.updated_at

`,
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
      now,
      now
    );

  }



  /*
  ==================================================
  FIND BY VERIFICATION ID
  ==================================================
  */


  findByVerificationId(
    verificationId:string
  ):VerificationResultRecord|null {


    return this.queryOne<VerificationResultRecord>(
`
SELECT *
FROM verification_results
WHERE verification_id = ?
LIMIT 1
`,
      verificationId
    );

  }



  /*
  ==================================================
  FIND LATEST EMAIL RESULT
  ==================================================
  */


  findLatestByEmail(
    email:string
  ):VerificationResultRecord|null {


    return this.queryOne<VerificationResultRecord>(
`
SELECT *
FROM verification_results
WHERE email = ?
ORDER BY created_at DESC
LIMIT 1
`,
      this.normalizeEmail(email)
    );

  }



  /*
  ==================================================
  FIND DOMAIN RESULTS
  ==================================================
  */


  findByDomain(
    domain:string
  ):VerificationResultRecord[] {


    return this.queryMany<VerificationResultRecord>(
`
SELECT *
FROM verification_results
WHERE domain = ?
ORDER BY created_at DESC
`,
      this.normalizeDomain(domain)
    );

  }



  /*
  ==================================================
  EXISTS
  ==================================================
  */


  existsByVerificationId(
    verificationId:string
  ):boolean {


    return this.exists(
`
SELECT 1
FROM verification_results
WHERE verification_id = ?
`,
      verificationId
    );

  }



  /*
  ==================================================
  DELETE
  ==================================================
  */


  deleteByVerificationId(
    verificationId:string
  ):number {


    return this.executeDelete(
`
DELETE FROM verification_results
WHERE verification_id = ?
`,
      verificationId
    );

  }
  /*
  ==================================================
  FIND BY VERIFICATION ID
  ==================================================
  */

}
