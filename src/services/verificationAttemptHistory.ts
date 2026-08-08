import { randomUUID } from "node:crypto";

import { getDatabase } from "../database/database.js";


/*
==================================================
VERIFICATION ATTEMPT HISTORY
==================================================

Purpose:

Stores every verification attempt.

It does NOT:
- calculate confidence
- determine recommendation
- modify pattern intelligence
- decide verification status

Those responsibilities belong elsewhere.

Storage: PostgreSQL (verification_attempt_history
table). Previously a local JSONL file — see
evidenceLedger.ts for why that doesn't work in a
horizontally-scaled, containerized deployment.
==================================================
*/


/*
==================================================
TYPES
==================================================
*/


export type VerificationAttemptOutcome =
  | "VERIFIED"
  | "INVALID"
  | "CATCH_ALL"
  | "TEMPORARY_FAILURE"
  | "UNKNOWN"
  | "DNS_ERROR"
  | "SMTP_ERROR";


export type VerificationAttemptMethod =
  | "SMTP"
  | "API"
  | "CACHE"
  | "OTHER";



export interface VerificationAttemptInput {

  email: string;

  domain?: string | null;


  method:
    VerificationAttemptMethod;


  outcome:
    VerificationAttemptOutcome;


  success: boolean;


  responseCode?: number | null;


  responseMessage?: string | null;


  mailboxExists?: boolean | null;


  smtpValid?: boolean | null;


  catchAll?: boolean | null;


  retryRequired?: boolean | null;


  retryReason?: string | null;


  mxAvailable?: boolean | null;


  mxHosts?: string[];


  primaryMX?: string | null;


  provider?: string | null;


  pattern?: string | null;


  verificationId?: string | null;


  requestId?: string | null;


  cacheHit?: boolean | null;


  cacheAgeMs?: number | null;


  errorCode?: string | null;


  errorMessage?: string | null;


  metadata?: Record<string, unknown>;

}



export interface VerificationAttemptRecord
  extends VerificationAttemptInput {


  id: string;


  timestamp: string;


  version: 1;


  email: string;


  domain: string | null;

}



/*
==================================================
NORMALIZATION
==================================================
*/


function normalizeEmail(
  email:string
):string {

  return email
    .trim()
    .toLowerCase();

}



function normalizeDomain(
  domain?:string|null
):string|null {


  if(
    !domain
  ){
    return null;
  }


  const normalized =
    domain
      .trim()
      .toLowerCase()
      .replace(
        /^https?:\/\//,
        ""
      )
      .replace(
        /^www\./,
        ""
      )
      .split("/")[0]
      ?.trim()
      ?? "";


  return normalized || null;

}



function extractDomain(
  email:string
):string|null {


  const index =
    email.lastIndexOf("@");


  if(
    index <= 0 ||
    index >= email.length - 1
  ){

    return null;

  }


  return email
    .slice(index + 1)
    .trim()
    .toLowerCase();

}



/*
==================================================
CREATE RECORD
==================================================
*/

function createRecord(
  input: VerificationAttemptInput
): VerificationAttemptRecord {


  const email =
    normalizeEmail(
      input.email
    );


  const domain =
    normalizeDomain(
      input.domain
    ) ??
    extractDomain(
      email
    );


  return {

    id:
      randomUUID(),


    timestamp:
      new Date().toISOString(),


    version:
      1,


    email,


    domain,


    method:
      input.method,


    outcome:
      input.outcome,


    success:
      Boolean(
        input.success
      ),


    responseCode:
      input.responseCode ?? null,


    responseMessage:
      input.responseMessage ?? null,


    mailboxExists:
      input.mailboxExists ?? null,


    smtpValid:
      input.smtpValid ?? null,


    catchAll:
      input.catchAll ?? null,


    retryRequired:
      input.retryRequired ?? null,


    retryReason:
      input.retryReason ?? null,


    mxAvailable:
      input.mxAvailable ?? null,


    mxHosts:
      Array.isArray(input.mxHosts) ? input.mxHosts : [],


    primaryMX:
      input.primaryMX ?? null,


    provider:
      input.provider ?? null,


    pattern:
      input.pattern ?? null,


    verificationId:
      input.verificationId ?? null,


    requestId:
      input.requestId ?? null,


    cacheHit:
      input.cacheHit ?? null,


    cacheAgeMs:
      input.cacheAgeMs ?? null,


    errorCode:
      input.errorCode ?? null,


    errorMessage:
      input.errorMessage ?? null,


    metadata:
      input.metadata ??
      {}

  };

}



/*
==================================================
PUBLIC WRITE API
==================================================
*/


export async function recordVerificationAttempt(
  input:VerificationAttemptInput
):Promise<VerificationAttemptRecord>{


  const record =
    createRecord(
      input
    );


  const db = getDatabase();

  await db.query(
    `
    INSERT INTO verification_attempt_history (
      id, email, domain, method, outcome, success,
      response_code, response_message,
      mailbox_exists, smtp_valid, catch_all, retry_required, retry_reason,
      mx_available, mx_hosts, primary_mx, provider, pattern,
      verification_id, request_id,
      cache_hit, cache_age_ms,
      error_code, error_message,
      metadata, created_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8,
      $9, $10, $11, $12, $13,
      $14, $15, $16, $17, $18,
      $19, $20,
      $21, $22,
      $23, $24,
      $25, $26
    )
    `,
    [
      record.id, record.email, record.domain, record.method, record.outcome, record.success,
      record.responseCode, record.responseMessage,
      record.mailboxExists, record.smtpValid, record.catchAll, record.retryRequired, record.retryReason,
      record.mxAvailable, JSON.stringify(record.mxHosts ?? []), record.primaryMX, record.provider, record.pattern,
      record.verificationId, record.requestId,
      record.cacheHit, record.cacheAgeMs,
      record.errorCode, record.errorMessage,
      JSON.stringify(record.metadata ?? {}), record.timestamp,
    ]
  );

  return record;

}



/*
==================================================
ROW MAPPING
==================================================
*/

interface AttemptHistoryRow {
  id: string;
  email: string;
  domain: string | null;
  method: VerificationAttemptMethod;
  outcome: VerificationAttemptOutcome;
  success: boolean;
  response_code: number | null;
  response_message: string | null;
  mailbox_exists: boolean | null;
  smtp_valid: boolean | null;
  catch_all: boolean | null;
  retry_required: boolean | null;
  retry_reason: string | null;
  mx_available: boolean | null;
  mx_hosts: unknown;
  primary_mx: string | null;
  provider: string | null;
  pattern: string | null;
  verification_id: string | null;
  request_id: string | null;
  cache_hit: boolean | null;
  cache_age_ms: number | null;
  error_code: string | null;
  error_message: string | null;
  metadata: unknown;
  created_at: string | Date;
}

function mapRow(row: AttemptHistoryRow): VerificationAttemptRecord {
  return {
    id: row.id,
    timestamp:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
    version: 1,

    email: row.email,
    domain: row.domain,

    method: row.method,
    outcome: row.outcome,
    success: row.success,

    responseCode: row.response_code,
    responseMessage: row.response_message,
    mailboxExists: row.mailbox_exists,
    smtpValid: row.smtp_valid,
    catchAll: row.catch_all,
    retryRequired: row.retry_required,
    retryReason: row.retry_reason,
    mxAvailable: row.mx_available,
    mxHosts: (row.mx_hosts as string[] | null) ?? [],
    primaryMX: row.primary_mx,
    provider: row.provider,
    pattern: row.pattern,
    verificationId: row.verification_id,
    requestId: row.request_id,
    cacheHit: row.cache_hit,
    cacheAgeMs: row.cache_age_ms,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    metadata: (row.metadata as Record<string, unknown> | null) ?? {},
  };
}



/*
==================================================
GET BY EMAIL
==================================================
*/


export async function getVerificationAttemptsByEmail(
  email:string
):Promise<VerificationAttemptRecord[]>{

  const db = getDatabase();

  const result = await db.query<AttemptHistoryRow>(
    `
    SELECT * FROM verification_attempt_history
    WHERE email = $1
    ORDER BY created_at DESC
    `,
    [normalizeEmail(email)]
  );

  return result.rows.map(mapRow);

}



/*
==================================================
GET BY VERIFICATION ID
==================================================
*/


export async function getVerificationAttemptsByVerificationId(
  verificationId:string
):Promise<VerificationAttemptRecord[]>{

  const db = getDatabase();

  const result = await db.query<AttemptHistoryRow>(
    `
    SELECT * FROM verification_attempt_history
    WHERE verification_id = $1
    ORDER BY created_at DESC
    `,
    [verificationId.trim()]
  );

  return result.rows.map(mapRow);

}


/*
==================================================
GET BY DOMAIN
==================================================
*/

export async function getVerificationAttemptsByDomain(
  domain:string
):Promise<VerificationAttemptRecord[]> {

  const normalizedDomain =
    normalizeDomain(
      domain
    );


  if(
    !normalizedDomain
  ){

    throw new Error(
      "domain is required"
    );

  }

  const db = getDatabase();

  const result = await db.query<AttemptHistoryRow>(
    `
    SELECT * FROM verification_attempt_history
    WHERE domain = $1
    ORDER BY created_at DESC
    `,
    [normalizedDomain]
  );

  return result.rows.map(mapRow);

}



/*
==================================================
LATEST ATTEMPT
==================================================
*/


export async function getLatestVerificationAttempt(
  email:string
):Promise<VerificationAttemptRecord|null>{


  const attempts =
    await getVerificationAttemptsByEmail(
      email
    );


  return attempts[0] ?? null;

}



/*
==================================================
COUNTERS
==================================================
*/


export async function countVerificationAttempts(
  email:string
):Promise<number>{


  const attempts =
    await getVerificationAttemptsByEmail(
      email
    );


  return attempts.length;

}



export async function countSuccessfulVerificationAttempts(
  email:string
):Promise<number>{


  const attempts =
    await getVerificationAttemptsByEmail(
      email
    );


  return attempts.filter(
    attempt =>
      attempt.success === true
  ).length;

}



export async function countFailedVerificationAttempts(
  email:string
):Promise<number>{


  const attempts =
    await getVerificationAttemptsByEmail(
      email
    );


  return attempts.filter(
    attempt =>
      attempt.success === false
  ).length;

}



/*
==================================================
SUMMARY
==================================================
*/


export interface VerificationAttemptSummary {


  email:string;


  totalAttempts:number;


  successfulAttempts:number;


  failedAttempts:number;


  temporaryFailures:number;


  invalidAttempts:number;


  catchAllAttempts:number;


  latestAttempt:
    VerificationAttemptRecord|null;


  firstAttemptAt:string|null;


  lastAttemptAt:string|null;

}




export async function getVerificationAttemptSummary(
  email:string
):Promise<VerificationAttemptSummary>{


  const attempts =
    await getVerificationAttemptsByEmail(
      email
    );



  if(
    attempts.length === 0
  ){

    return {

      email:
        normalizeEmail(
          email
        ),

      totalAttempts:0,

      successfulAttempts:0,

      failedAttempts:0,

      temporaryFailures:0,

      invalidAttempts:0,

      catchAllAttempts:0,

      latestAttempt:null,

      firstAttemptAt:null,

      lastAttemptAt:null

    };

  }



  const chronological =
    [...attempts].sort(
      (
        a,
        b
      ) =>
        new Date(
          a.timestamp
        ).getTime()
        -
        new Date(
          b.timestamp
        ).getTime()
    );



  return {


    email:
      normalizeEmail(
        email
      ),


    totalAttempts:
      attempts.length,


    successfulAttempts:
      attempts.filter(
        attempt =>
          attempt.success
      ).length,


    failedAttempts:
      attempts.filter(
        attempt =>
          !attempt.success
      ).length,


    temporaryFailures:
      attempts.filter(
        attempt =>
          attempt.outcome ===
          "TEMPORARY_FAILURE"
      ).length,


    invalidAttempts:
      attempts.filter(
        attempt =>
          attempt.outcome ===
          "INVALID"
      ).length,


    catchAllAttempts:
      attempts.filter(
        attempt =>
          attempt.outcome ===
          "CATCH_ALL"
      ).length,


    latestAttempt:
      attempts[0] ??
      null,


    firstAttemptAt:
      chronological[0]?.timestamp ??
      null,


    lastAttemptAt:
      attempts[0]?.timestamp ??
      null

  };

}



/*
==================================================
CLEAR HISTORY
==================================================
*/


export async function clearVerificationAttemptHistory()
:Promise<void>{

  const db = getDatabase();

  await db.query(`TRUNCATE TABLE verification_attempt_history`);

}
