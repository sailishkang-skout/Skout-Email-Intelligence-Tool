import { randomUUID } from "node:crypto";

import {
  appendFile,
  mkdir,
  readFile
} from "node:fs/promises";

import path from "node:path";


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

==================================================
*/


/*
==================================================
STORAGE
==================================================
*/

const DEFAULT_STORAGE_DIR =
  path.resolve(
    process.env.VERIFICATION_ATTEMPT_HISTORY_DIR ??
      "./data"
  );


const DEFAULT_STORAGE_FILE =
  path.join(
    DEFAULT_STORAGE_DIR,
    "verification-attempt-history.jsonl"
  );


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
SAFE HELPERS
==================================================
*/


function nullableBoolean(
  value?:boolean|null
):boolean|null {


  if(
    value === undefined ||
    value === null
  ){

    return null;

  }


  return Boolean(value);

}



function nullableNumber(
  value?:number|null
):number|null {


  if(
    value === undefined ||
    value === null
  ){

    return null;

  }


  return Number.isFinite(value)
    ? value
    : null;

}



function nullableString(
  value?:string|null
):string|null {


  if(
    value === undefined ||
    value === null
  ){

    return null;

  }


  const clean =
    value.trim();


  return clean || null;

}



function normalizeStringArray(
  value?:string[]
):string[] {


  if(
    !Array.isArray(value)
  ){

    return [];

  }


  return value
    .filter(
      (
        item
      ):item is string =>
        typeof item === "string"
    )
    .map(
      item =>
        item.trim()
    )
    .filter(Boolean);

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
      nullableNumber(
        input.responseCode
      ),


    responseMessage:
      nullableString(
        input.responseMessage
      ),


    mailboxExists:
      nullableBoolean(
        input.mailboxExists
      ),


    smtpValid:
      nullableBoolean(
        input.smtpValid
      ),


    catchAll:
      nullableBoolean(
        input.catchAll
      ),


    retryRequired:
      nullableBoolean(
        input.retryRequired
      ),


    retryReason:
      nullableString(
        input.retryReason
      ),


    mxAvailable:
      nullableBoolean(
        input.mxAvailable
      ),


    mxHosts:
      normalizeStringArray(
        input.mxHosts
      ),


    primaryMX:
      nullableString(
        input.primaryMX
      ),


    provider:
      nullableString(
        input.provider
      ),


    pattern:
      nullableString(
        input.pattern
      ),


    verificationId:
      nullableString(
        input.verificationId
      ),


    requestId:
      nullableString(
        input.requestId
      ),


    cacheHit:
      nullableBoolean(
        input.cacheHit
      ),


    cacheAgeMs:
      nullableNumber(
        input.cacheAgeMs
      ),


    errorCode:
      nullableString(
        input.errorCode
      ),


    errorMessage:
      nullableString(
        input.errorMessage
      ),


    metadata:
      input.metadata ??
      {}

  };

}



/*
==================================================
WRITE RECORD
==================================================
*/


async function writeRecord(
  record:VerificationAttemptRecord
):Promise<void>{


  await mkdir(
    DEFAULT_STORAGE_DIR,
    {
      recursive:true
    }
  );


  await appendFile(
    DEFAULT_STORAGE_FILE,
    `${JSON.stringify(record)}\n`,
    "utf8"
  );

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


  await writeRecord(
    record
  );


  return record;

}



/*
==================================================
READ ALL RECORDS
==================================================
*/


async function readAllRecords()
:Promise<VerificationAttemptRecord[]>{


  try {


    const content =
      await readFile(
        DEFAULT_STORAGE_FILE,
        "utf8"
      );


    if(
      !content.trim()
    ){

      return [];

    }



    const records:
      VerificationAttemptRecord[] =
      [];



    for(
      const line of content.split("\n")
    ){


      if(
        !line.trim()
      ){

        continue;

      }



      try {


        const parsed =
          JSON.parse(
            line
          );



        if(
          parsed &&
          typeof parsed === "object" &&
          typeof parsed.id === "string" &&
          typeof parsed.email === "string"
        ){

          records.push(
            parsed as VerificationAttemptRecord
          );

        }


      }catch{


        /*
        Ignore corrupted lines.
        Historical data should not crash service.
        */


        continue;

      }

    }



    return records;



  }catch(error:unknown){


    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error
        ? error.code
        : null;



    if(
      code === "ENOENT"
    ){

      return [];

    }



    throw error;

  }

}



/*
==================================================
GET ALL
==================================================
*/


export async function getVerificationAttempts()
:Promise<VerificationAttemptRecord[]>{


  return readAllRecords();

}



/*
==================================================
GET BY EMAIL
==================================================
*/


export async function getVerificationAttemptsByEmail(
  email:string
):Promise<VerificationAttemptRecord[]>{


  const normalized =
    normalizeEmail(
      email
    );



  const records =
    await readAllRecords();



  return records
    .filter(
      record =>
        record.email === normalized
    )
    .sort(
      (
        a,
        b
      ) =>
        new Date(
          b.timestamp
        ).getTime()
        -
        new Date(
          a.timestamp
        ).getTime()
    );

}



/*
==================================================
GET BY VERIFICATION ID
==================================================
*/


export async function getVerificationAttemptsByVerificationId(
  verificationId:string
):Promise<VerificationAttemptRecord[]>{


  const id =
    verificationId.trim();



  const records =
    await readAllRecords();



  return records
    .filter(
      record =>
        record.verificationId === id
    )
    .sort(
      (
        a,
        b
      ) =>
        new Date(
          b.timestamp
        ).getTime()
        -
        new Date(
          a.timestamp
        ).getTime()
    );

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



  const records =
    await readAllRecords();



  return records
    .filter(
      record =>
        record.domain === normalizedDomain
    )
    .sort(
      (
        a,
        b
      ) =>
        new Date(
          b.timestamp
        ).getTime()
        -
        new Date(
          a.timestamp
        ).getTime()
    );

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


  await mkdir(
    DEFAULT_STORAGE_DIR,
    {
      recursive:true
    }
  );



  const {
    writeFile
  } =
    await import(
      "node:fs/promises"
    );



  await writeFile(
    DEFAULT_STORAGE_FILE,
    "",
    "utf8"
  );

}



/*
==================================================
STORAGE LOCATION
==================================================
*/


export function getVerificationAttemptHistoryStoragePath()
:string{


  return DEFAULT_STORAGE_FILE;

}